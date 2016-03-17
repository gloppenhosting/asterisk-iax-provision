'use strict'

var domain = require('domain').create();
var os = require('os');
var moment = require('moment');
var config = require('config');
var mysql_config = config.get('mysql');
var asterisk_config = config.get('asterisk');
var debug = process.env.NODE_DEBUG || config.get('debug') || true;

var knex = require('knex')(
{
  client: 'mysql2',
  connection: {
    host     : (process.env.MYSQL_HOST || mysql_config.get('host') || '127.0.0.1'),
    user     : (process.env.MYSQL_USER || mysql_config.get('user') || 'root'),
    password : (process.env.MYSQL_PASSWORD || mysql_config.get('password') || ''),
    database : (process.env.MYSQL_DB || mysql_config.get('database') || 'asterisk')
  },
  pool: {
      min: 1,
      max: 1
  }
});

// On any errors. Write them to console and exit program with error code
domain.on('error', function (err) {
    if (debug) {
      console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), err);
    }

    process.exit(1);
});

// Encapsulate it all into a domain to catch all errors
domain.run(function () {

  var hostname = os.hostname();

  knex.transaction(function(trx) {
      trx('call_channels')
      .where('caller_server', hostname)
      .orWhere('callee_server', hostname)
      .delete()
      .then(function (){
          trx('parkinglots')
          .where('iaxfriends_name', hostname)
          .update({
              iaxfriends_name: null
          })
          .then(function () {
              trx('queues_meta')
              .where('iaxfriends_name', hostname)
              .update({
                  iaxfriends_name: null
              })
              .then(function () {
                  trx('iaxfriends')
                  .where('iaxfriends_name', hostname)
                  .increment('restarts', 1)
                  .then(trx.commit)
                  .catch(trx.rollback);
              })
              .catch(trx.rollback);
          })
          .catch(trx.rollback);
      })
      .catch(trx.rollback);
  })
  .then(function(resp) {
    if (debug) {
      console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Cleaned up', resp, 'rows in call_channels, queues_meta and parkinglots');
    }

    process.exit(0);
  })
  .catch(function(err) {
    if (debug) {
      console.error(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), err);
    }

    process.exit(1);
  });
});
