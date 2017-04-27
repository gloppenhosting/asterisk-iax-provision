'use strict'

var domain = require('domain').create();
var os = require('os');
var ip = require("ip");
var extIP = require('external-ip');
var moment = require('moment');
var config = require('config');
var randomstring = require("randomstring");
var mysql_config = config.get('mysql');
var asterisk_config = config.get('asterisk');
var aws_config = config.get('aws');
var md5 = require('md5');
var debug = process.env.NODE_DEBUG || config.get('debug') || true;
var AWS = require('aws-sdk');
var fs = require('fs');
var heartBeatInterval = null;

// On any errors. Write them to console and exit program with error code
domain.on('error', function(err) {
    if (debug)
        console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), err);
    process.exit(1);
});

// Encapsulate it all into a domain to catch all errors
domain.run(function() {

    var knex = require('knex')({
        client: 'mysql',
        connection: {
            host: (process.env.MYSQL_HOST || mysql_config.get('host') || '127.0.0.1'),
            user: (process.env.MYSQL_USER || mysql_config.get('user') || 'root'),
            password: (process.env.MYSQL_PASSWORD || mysql_config.get('password') || ''),
            database: (process.env.MYSQL_DB || mysql_config.get('database') || 'asterisk')
        },
        pool: {
            ping: function ping(connection, callback) {
                try {
                    connection.ping(callback);
                } catch (err) {
                    process.nextTick(callback.bind(null, err));
                }
            },
            min: 1,
            max: 2
        }
    });

    if (heartBeatInterval) {
        clearInterval(heartBeatInterval)
        heartBeatInterval = null;
    }

    heartBeatInterval = setInterval(function() {
        knex.raw('SELECT 1=1')
            .then(function() {
                //  log.info('heartbeat sent');
            })
            .catch(function(err) {
                console.error('Knex heartbeat error, shutting down', err);
                process.exit(1);
            })
    }, 10000);

    var externalIP = extIP({
        replace: true,
        services: ['http://ip.tyk.nu'],
        timeout: 600,
        getIP: 'parallel'
    });

    // AWS Config
    AWS.config.update({
        accessKeyId: (process.env.AWS_ACCESS_KEY || aws_config.get('accessKeyId') || ''),
        secretAccessKey: (process.env.AWS_SECRET_KEY || aws_config.get('secretAccessKey') || '')
    });

    // Set your region for future requests.
    AWS.config.update({
        region: (process.env.AWS_REGION || aws_config.get('region') || 'eu-west-1')
    }); // e.g. eu-west-1

    // get the Route53 library
    var route53 = new AWS.Route53();

    // only update route 53 if public ip changes!
    var last_known_external_ip = null;
    var clear_external_ip_timer = false;

    // Create update function for update timer
    var update = function() {

        // Grab ips and hostname
        var hostname = os.hostname();
        var internal_ip_address = ip.address();
        var external_ip_address = '';

        // Grab external ip
        externalIP(function(err, ip) {
            if (err) return;
            external_ip_address = ip;

            // check if we already have the info from the host in iax friends. If not then insert, else update it!
            knex
                .select('id', 'hostname')
                .from(asterisk_config.get('iaxtable'))
                .where('name', hostname)
                .orWhere('local_ip', internal_ip_address)
                .orWhere('ipaddr', external_ip_address)
                .limit(1)
                .asCallback(function(err, rows) {
                    if (err) return;

                    // Define our iaxfriends object from our database table
                    var serverobj = {
                        name: hostname,
                        regserver: hostname,
                        type: 'friend',
                        username: hostname,
                        context: hostname.indexOf('upstream') > -1 ? 'fromupstream' : 'fromasterisk',
                        host: external_ip_address,
                        local_ip: internal_ip_address,
                        ipaddr: external_ip_address,
                        port: 4569,
                        mask: '255.255.255.255',
                        trunk: 'no',
                        encryption: 'no',
                        transfer: 'mediaonly',
                        jitterbuffer: 'no',
                        forcejitterbuffer: 'no',
                        disallow: 'all',
                        timezone: 'Europe/Oslo',
                        qualify: 'yes',
                        qualifyfreqok: 25000,
                        qualifyfreqnotok: 10000,
                        provision_last_response: moment(new Date()).format("YYYY-MM-DD HH:mm:ss"),
                        is_upstream: hostname.indexOf('upstream') > -1 ? 1 : 0,
                        inkeys: 'IAXTrunk',
                        outkeys: 'IAXTrunk',
                        allow: 'g722,ulaw,alaw',
                        manager_password: 'WLhQWSbPzMvsnq1W',
                        ari_password: 'oPNl8mGtWNBcWS6l'
                            //auth: 'rsa',
                    };

                    // If rows lenth is > 0 then then server already exists!
                    if (rows.length > 0) {

                        // Dont set the provision date
                        delete serverobj.provision_date;

                        if (rows[0].hostname && rows[0].hostname.toString().indexOf('publicdns.zone') > -1) {
                            serverobj.hostname = rows[0].hostname;
                        } else {
                            serverobj.hostname = md5(hostname) + '-voip-aws-eu.publicdns.zone';
                        }

                        knex.transaction(function(trx) {
                                trx
                                    .where('name', '=', hostname)
                                    .update(serverobj)
                                    .into(asterisk_config.get('iaxtable'))
                                    .then(trx.commit)
                                    .catch(trx.rollback);
                            })
                            .then(function(resp) {
                                if (debug) {
                                    console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Updated server', hostname, 'with private ip', internal_ip_address, 'and public ip', external_ip_address, 'in', asterisk_config.get('iaxtable'));
                                }
                            })
                            .catch(function(err) {
                                if (debug) {
                                    console.error(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), err);
                                }
                            });

                    } else {

                        // Set provision date and last update
                        serverobj.provision_date = moment(new Date()).format("YYYY-MM-DD HH:mm:ss");
                        serverobj.provision_last_response = serverobj.provision_date;
                        serverobj.secret = randomstring.generate({
                            length: 32,
                            charset: 'alphanumeric'
                        });
                        serverobj.hostname = md5(hostname) + '-voip-aws-eu.publicdns.zone';

                        knex.transaction(function(trx) {
                                trx
                                    .insert(serverobj)
                                    .into(asterisk_config.get('iaxtable'))
                                    .then(trx.commit)
                                    .catch(trx.rollback);
                            })
                            .then(function(resp) {
                                if (debug) {
                                    console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Added server', hostname, 'with private ip', internal_ip_address, 'and public ip', external_ip_address, 'to', asterisk_config.get('iaxtable'));
                                }
                            })
                            .catch(function(err) {
                                if (debug) {
                                    console.error(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), err);
                                }
                            });
                    }

                    if (last_known_external_ip != external_ip_address) {
                        var params = {
                            "HostedZoneId": '/hostedzone/ZZJQS6MJNJD68', // zone id
                            "ChangeBatch": {
                                "Changes": [{
                                    "Action": "UPSERT",
                                    "ResourceRecordSet": {
                                        "Name": serverobj.hostname,
                                        "Type": "A",
                                        "TTL": 60,
                                        "ResourceRecords": [{
                                            "Value": external_ip_address
                                        }]
                                    }
                                }]
                            }
                        };

                        route53.changeResourceRecordSets(params, function(err, data) {
                            if (!err) {
                                if (debug) {
                                    console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Updated Amazon Route53 DNS', serverobj.hostname, 'with public ip', external_ip_address);
                                }

                                last_known_external_ip = external_ip_address;

                                if (!clear_external_ip_timer) {
                                    clear_external_ip_timer = setInterval(function() {
                                        last_known_external_ip = null;
                                    }, 1000 * 60 * 5);
                                }
                            } else {
                                last_known_external_ip = null;
                            }
                        });
                    }
                });
        });

    };

    if (debug) {
        console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Will update', asterisk_config.get('iaxtable'), 'every', config.get('update_interval_sec'), 'seconds with peer information');
    }

    // Lets update on first run!
    update();

    // Start timer
    var update_timer = setInterval(function() {
            update();
        },
        (config.get('update_interval_sec') * 1000 * 3)
    );
});
