const p2p = require('ravencore-p2p');
const express = require('express');
const tableify = require('tableify');
const geoip = require('geoip-lite');
const countries = require('i18n-iso-countries');
const regions = require('country-region');
const level = require('level');
const maxmind = require('maxmind');
const ravencore_lib = require('ravencore-lib');
const networks = require('./networks');
const BitSet = require('bitset');
const fs = require('fs');

var network_name = "rvn";
let api_port = 3000;
let cwd = process.cwd();

const asnLookup = maxmind.openSync(cwd+'/GeoLite2-ASN.mmdb');

const stay_connected_time = 1000*60*5;//how long to wait for addr messages.
let max_concurrent_connections = 500;
let max_failed_connections_per_minute = 1000;
const max_age = 1000*60*60*5;
const addr_db_ttl = -1;//How long to save addr messages for. The saved addr messages are currently not used for anything. 0 = never delete, -1 = never save
const connect_timeout = 1000*60;
const handshake_timeout = 1000*60;


var dir = cwd+'/databases';
if (!fs.existsSync(dir)){
  fs.mkdirSync(dir);
}



let indexTasks = [];

process.argv.forEach(function (val, index, array) {
  let arr = val.split("=");
  if (arr.length === 2 && arr[0] === "-network") {
    network_name = arr[1];
  }
  if (arr.length === 2 && arr[0] === "-port") {
    api_port = arr[1];
  }
  if (arr.length === 2 && arr[0] === "-max_concurrent_connections") {
    max_concurrent_connections = Number(arr[1]);
  }
  if (arr.length === 2 && arr[0] === "-max_failed_connections_per_minute") {
    max_failed_connections_per_minute = Number(arr[1]);
  }
  if (arr.length === 1 && arr[0] === "-reindex-connection-ip-addresses") {
    indexTasks.push(reindexConnectionIpAddresses);
  }
  if (arr.length === 1 && arr[0] === "-reindex-connection-times") {
    indexTasks.push(reindexConnectionTimes);
  }
}); 



let protocolVersion;
let seedNodes;
let heightIncludeUA;
networks.forEach(network => {
  if (network.name===network_name) {
    protocolVersion = network.protocolVersion;
    seedNodes = network.seedNodes;
    heightIncludeUA = network.heightIncludeUA;
  }
  ravencore_lib.Networks.add(network);
});

const db = level(cwd+'/databases/'+network_name, { valueEncoding: 'json', cacheSize: 128*1024*1024, blockSize: 4096, writeBufferSize: 4*1024*1024 });


//Database key prefixes
const connection_prefix = "connection/";
const connection_by_time_prefix = "connection-by-time/";
const connection_by_ip_prefix = "connection-by-ip/";// /ip/time/connectionId
const addr_prefix = "addr/"
const addr_by_time_prefix = "addr-by-time/"
const host2lastaddr_prefix = 'host2lastaddr/';

let paused = false;

let queue = [];

let status_string = "";

let lastRefreshTime = 0;
let lastConnectTime = 0;

let concurrent_connections = 0;

let failed_connections_queue = [];//queue of timestamps

const messages = new p2p.Messages();

var app = express();

app.get('/node_count', function (req, res) {
  let hours = req.query.hours;
  if (!isFinite(hours) || hours > 10) hours = 10;
  let host2lastconnection = {};
  let host2active = {};
  recentConnections(1000*60*60*hours)
  .on('data', function(connection) {
    let key = connection.host+":"+connection.port;
    if (host2lastconnection[key] === undefined || connection.connectTime > host2lastconnection[key].connectTime)  {
      host2lastconnection[key] = connection;
    }
  })
  .on('close', function() {
	  let hostAll = Object.keys(host2lastconnection).length;
	  let hostSuccess = Object.keys(host2lastconnection).filter(host => host2lastconnection[host].success).length;
	  let hostFailed = hostAll - hostSuccess;
    res.send(
	  "All: "+hostAll+"<br>"+
      "Success: "+hostSuccess+"<br>"+
	  "Failed: "+hostFailed+"<br>"
    );
  });
});

app.get('/node_list', function (req, res) {
  let hours = req.query.hours;
  if (!isFinite(hours) || hours > 10) hours = 10;
  let host2lastconnection = {};
  let host2active = {};
  recentConnections(1000*60*60*hours)
  .on('data', function(connection) {
    let key = connection.host+":"+connection.port;
    if (host2lastconnection[key] === undefined || connection.connectTime > host2lastconnection[key].connectTime)  {
      host2lastconnection[key] = connection;
    }
  })
  .on('close', function() {
	let css = "<head><style>body {  background: #000; } table {  text-align: left;  margin: auto;  /*! border: 3px solid #9d9d9d; */ } table td, table th {  border: 3px solid #9d9d9d;  padding: 5px 2px; } table tbody td {  color: #9D9D9D; } table tr:nth-child(even) {  background: black;  border: 3px solid #9d9d9d; } table tbody tr {  background: #000;  border: 3px solid #5d4343; } table thead tr {  background: #9d9d9d; } table thead th {  font-size: 20px;  font-weight: bold;  color: #000;  text-align: left; } table tfoot {  font-size: 13px;  font-weight: bold;  color: #FFFFFF;  background: #CE3CFF;  background: -moz-linear-gradient(top, #da6dff 0%, #d34fff 66%, #CE3CFF 100%);  background: -webkit-linear-gradient(top, #da6dff 0%, #d34fff 66%, #CE3CFF 100%);  background: linear-gradient(to bottom, #da6dff 0%, #d34fff 66%, #CE3CFF 100%);  border-top: 5px solid #792396; } table tfoot td {  font-size: 13px; } table tfoot .links {  text-align: right; } table tfoot .links a {  display: inline-block;  background: #792396;  color: #FFFFFF;  padding: 2px 8px;  border-radius: 5px; } table tbody tr:hover, table tbody td:hover {  background: #005107; }</style></head>"
	let hostList = Object.values(host2lastconnection);
	hostList = hostList.filter(obj => {return obj.success === true});
	hostList = hostList.map(obj => ({ 
		host: obj.host + ':' + obj.port,
		version: obj.version,
		bestHeight: obj.bestHeight,
		lat: obj.lat,
		long: obj.long,
		location: obj.location
	}));
	hostCount = hostList.length;
	hostList = hostList.sort(function(a, b){return b.version - a.version});
	hostList = tableify(hostList).replace('host','host  ('+hostCount+')');
    res.send(
	  css +
      hostList
    );
  });
});

app.get('/connections/:host_ip.csv', function(req, res) {
  let ip = req.params.host_ip;
  let delimiter = ","
  let result = "";
  connectionsByHost(ip)
  .on('data', function(connection) {
    //if (connection.host !== ip) return;
	let readableDate = new Date(connection.connectTime);
	readableDate = (readableDate.getMonth() + 1) +
	"/" + readableDate.getDate() +
	"/" + readableDate.getFullYear() +
	" " + readableDate.getHours() + 
	":" + readableDate.getMinutes();
    let columns = [readableDate, 
      connection.host,
      connection.port];
    if (connection.success !== undefined) {
      columns.push(connection.bestHeight);
      columns.push(connection.version);
      columns.push(connection.subversion);
      columns.push(connection.services);
    }
    if (result.length > 0) result += "\n";
    result += columns.join(delimiter);  
  })
  .on('close', function() {
    res.set('Content-Type', 'text/csv');
    res.send(result);
  });
});

app.get('/debug', function(req, res) {
  res.set('Content-Type', 'application/json');
  res.send(data);
});

app.get('/map', function(req, res) {
  let hours = req.query.hours;
  if (!isFinite(hours) || hours > 10) hours = 10;
  let host2lastconnection = {};
  let host2active = {};
  recentConnections(1000*60*60*hours)
  .on('data', function(connection) {
    let key = connection.host+":"+connection.port;
    if (host2lastconnection[key] === undefined || connection.connectTime > host2lastconnection[key].connectTime)  {
      host2lastconnection[key] = connection;
    }
  })
  .on('close', function() {
	let hostList = Object.values(host2lastconnection);
	hostList = hostList.filter(obj => {return obj.success === true});
	hostCount = hostList.length;
	hostList = hostList.map(obj => ({ 
		host: obj.host,
		port: obj.port,
		version: obj.version,
		bestHeight: obj.bestHeight,
		lat: obj.lat,
		long: obj.long,
		location: obj.location,
		country: obj.country,
	}));
	console.log(__dirname + '/node_modules')
	app.use("/node_modules", express.static(__dirname + '/node_modules'));
	let peerInfo = [];
	let Highlight = [];
	for (i = 0; i < hostList.length; i++) {
		let escapeLocation = hostList[i].location;
		if (hostList[i].location){escapeLocation = hostList[i].location.replace(/'/g, "\\\'");}
		peerInfo.push(
			"{host: '"+hostList[i].host+"',"+
			"port: "+hostList[i].port+","+
			"version: "+hostList[i].version+","+
			"bestHeight: "+hostList[i].bestHeight+","+
			"location: '"+escapeLocation+"',"+
			"latitude: "+hostList[i].lat+","+
			"longitude: "+hostList[i].long+","+
			"radius: 3, fillKey: 'peer'}"
		);
		if (hostList[i].country){Highlight.push(hostList[i].country);}
	};
	let count = {};
    Highlight.forEach(function(i) { count[i] = (count[i]||0) + 1;});
	Highlight = [...new Set(Highlight)];
	let optionsData = [];
	for (j = 0; j < Highlight.length; j++ ){
		let countryName = Highlight[j]
		if (countryName == "United States") {countryName = "United States of America"}
		countryCode = countries.getAlpha3Code(countryName,'en');
		if (countryName == "United States of America") {countryName = "United States"}
		optionsData.push(countryCode+": { fillKey: 'active', count: "+count[countryName]+" }");		
	}
	let popupBubbles = "map.bubbles(["+
	  peerInfo +
	  "], {"+
	  "popupTemplate: function(geo, data) {"+
	    "return \"<div class='hoverinfo'>"+
		"host: \" + data.host + \":\" + data.port + \"<br>"+
		"version: \" + data.version + \"<br>"+
		"height: \" + data.bestHeight + \"<br>"+
		"location: \" + data.location + \"<br>"+
		"<strong>click to download nodes info!</strong>\""+
	  "}"+
	  "})";
	let popupMain = "popupTemplate: function(geography, data) {"+
          "return \"<div class='hoverinfo'><strong>\" + geography.properties.name + \" (\"+data.count+\")</strong></div>\";"+
        "}";
	let bubblesConfig = "options.bubblesConfig = {"+
        "borderWidth: 0,"+
        "borderOpacity: 0,"+
        "borderColor: '#FFFFFF',"+
        "fillOpacity: 1,"+
        "animate: true,"+
        "highlightOnHover: true,"+
        "highlightFillColor: '#FC8D59',"+
        "highlightBorderColor: 'rgba(250, 15, 160, 0.2)',"+
        "highlightBorderWidth: 2,"+
        "highlightBorderOpacity: 1,"+
        "highlightFillOpacity: 0.85"+
    "};";
	let newMap = "<head>"+
	  "<script src='//cdnjs.cloudflare.com/ajax/libs/d3/3.5.3/d3.min.js'></script>"+
	  "<script src='//cdnjs.cloudflare.com/ajax/libs/topojson/1.6.9/topojson.min.js'></script>"+
	  "<script src='https://ajax.googleapis.com/ajax/libs/jquery/3.3.1/jquery.min.js'></script>"+
	  "<script src='node_modules/datamaps/dist/datamaps.world.hires.min.js'></script>"+
	  "</head>"+
	  "<body style='background: #000; overflow: hidden; margin:10 auto;'>"+
	  "<div id='container'></div>"+
	  "<script>"+
	  "let options = {};"+
	  "options.element = document.getElementById('container');" +
	  "options.scope = 'world';" +
	  "options.geographyConfig = {"+
	  "popupOnHover: true,"+
	  "highlightOnHover: false,"+
	  "borderWidth: 1,"+
      "borderOpacity: 1,"+
      "borderColor: '#000',"+
	  popupMain +
	  "};"+
	  "options.done = function(datamap) {"+
            "$(datamap.svg[0][0]).on('click', '.bubbles', function(e) {"+
			    "let bubbleInfo = JSON.parse(e.target.dataset.info);"+
                "open('http://'+window.location.host+'/connections/'+bubbleInfo.host+'.csv');"+
            "});"+
        "};"+
	  "options.geographyConfig.highlightFillColor = '#59fc8d';"+
	  "options.responsive = true;"+
	  "options.projection = 'equirectangular';"+
	  'options.fills = {'+
	    'defaultFill: "#3c3c3c",'+
	    'peer: "#ffffff",'+
		'active: "#696969"'+
	  '};'+
	  bubblesConfig +
	  'options.data = {'+
      optionsData +
	  '};'+
	  "var map = new Datamap(options);"+
	  "window.addEventListener('resize', function(event){map.resize();});"+
	  popupBubbles+
	  "</script>"+
	  "</body>";
	res.send(newMap);
	});
});

function formatPercentage(val) {
  if (isNaN(val)) val = 0;
  return (val*100).toFixed(2)+"%";
}

let data = {
  epoch_hour: 0,
  active_host: 0,
  hour2first_and_last_connection_time: {},
  hostdata: {
    host2active: {},
    host2lastconnection: {}
  }
};

function add_connection2data(connection) {
  if (shifting_data) {//delay by 1 second
    setTimeout(function() {
      add_connection2data(connection);
    }, 1000);
    return;
  }
  let connectTime = connection.connectTime;
  let connect_hour = Math.floor(connectTime/(1000*60*60));
  let hours_ago = data.epoch_hour-connect_hour;
  if (hours_ago < 0) return;
  let host = connection.host+":"+connection.port;
  if (data.hour2first_and_last_connection_time[hours_ago] === undefined) {
    data.hour2first_and_last_connection_time[hours_ago] = {min: connectTime, max: connectTime};
  } else {
    if (connectTime < data.hour2first_and_last_connection_time[hours_ago].min) {
      data.hour2first_and_last_connection_time[hours_ago].min = connectTime;
    }
    if (connectTime > data.hour2first_and_last_connection_time[hours_ago].max) {
      data.hour2first_and_last_connection_time[hours_ago].max = connectTime;
    }
  }

  if (data.hostdata.host2active[host] === undefined) {
    data.hostdata.host2active[host] = new BitSet();
  }  
  data.hostdata.host2active[host].set(hours_ago, connection.success ? 1 : 0); 
  if (connection.success && (data.hostdata.host2lastconnection[host] === undefined || data.hostdata.host2lastconnection[host].connectedTime < connection.connectedTime)) {
    data.hostdata.host2lastconnection[host] = connection;
  }
}

function reindexConnectionTimes() {
  console.log("reindexing connection times");
  return new Promise(function(resolve, reject) {
    let ops = [];
    db.createReadStream({
      gt: connection_prefix, 
      lt: connection_prefix+"z"
    })
    .on('data', function (data) {
      connectionFound = true;
      let connection = data.value;
      let connectionId = data.key.substr(data.key.indexOf("/")+1);
      if (ops.length >= 1000) {
        db.batch(ops, function (err) {
          if (err) return console.log('Ooops!', err);
        });
        ops = [];
      }
      ops.push({type: 'put', key: connection_by_time_prefix+integer2LexString(connection.connectTime)+"/"+connectionId, value: connection});
    })  
    .on('error', function (err) {
      console.log("GOT db error2", err);
    })
    .on('close', function () {
      db.batch(ops, function (err) {
        if (err) return console.log('Ooops!', err);
        resolve();
      });
    })
    .on('end', function () {
    });
  });  
}

function reindexConnectionIpAddresses() {
  console.log("reindexing connection ip addresses");
  return new Promise(function(resolve, reject) {
    let ops = [];
    db.createReadStream({
      gt: connection_prefix, 
      lt: connection_prefix+"z"
    })
    .on('data', function (data) {
      connectionFound = true;
      let connection = data.value;
      let connectionId = data.key.substr(data.key.indexOf("/")+1);
      if (ops.length >= 1000) {
        db.batch(ops, function (err) {
          if (err) return console.log('Ooops!', err);
        });
        ops = [];
      }
      ops.push({type: 'put', key: connection_by_ip_prefix+connection.host+"/"+integer2LexString(connection.connectTime)+"/"+connectionId, value: connection});
    })
    .on('error', function (err) {
      console.log("GOT db error3", err);
    })
    .on('close', function () {
      db.batch(ops, function (err) {
        if (err) return console.log('Ooops!', err);
        resolve();
      });
    })
    .on('end', function () {
    });
  });
}

function loadDataFromDb() {
  let currentTime = (new Date()).getTime();
  data.epoch_hour = Math.floor(currentTime/(1000*60*60));
  return new Promise(function(resolve, reject) {
    recentConnections(1000*60*60*24*30)
    .on('data', function(connection) {
      add_connection2data(connection);
    })  
    .on('close', function() {
      resolve();
    });
  });
}

function shift_data_one_hour() {
  let shifted = {};
  Object.keys(data.hour2first_and_last_connection_time).forEach(hour => {
    let oldHour = Number(hour);
    let newHour = oldHour+1;
    if (newHour > 24*30) return;//only keep 30 days
    shifted[newHour] = data.hour2first_and_last_connection_time[oldHour];
  });
  data.hour2first_and_last_connection_time = shifted;

  Object.keys(data.hostdata.host2lastconnection).forEach(host => {
    let lastConnection = data.hostdata.host2lastconnection[host];
    let last_connect_hour = Math.floor(lastConnection.connectTime/(1000*60*60));
    if (data.epoch_hour-last_connect_hour > 24*30) {
      delete data.hostdata.host2lastconnection[host];
      return;
    }
    for (let i = 24*30; i > 0; i--) {
      data.hostdata.host2active[host].set(i, data.hostdata.host2active[host].get(i-1));
    }
    data.hostdata.host2active[host].set(0, 0);
  });
}

let shifting_data = false;

function update_if_hour_changed() {
  let currentTime = (new Date()).getTime();
  let epoch_hour = Math.floor(currentTime/(1000*60*60));
  if (data.epoch_hour >= epoch_hour) return;
  shifting_data = true;
  console.log("Hour changed. Updating uptimes");
  data.epoch_hour = epoch_hour;
  shift_data_one_hour();
  shifting_data = false;
}

var p = Promise.resolve();
indexTasks.forEach(indexTask => {
  p = p.then(() => indexTask());//sequentially execute indextasks
})
p.then(function() {
  console.log("Loading connections from db. This can take a while.");
  loadDataFromDb().then(function() {
    console.log("Data loaded. Acccepting requests");
    app.listen(api_port);
    setInterval(connectToPeers, 50);
  
    if (addr_db_ttl !== undefined && addr_db_ttl > 0) 
      setInterval(removeOldAddr, 1000*60);
  });
});


function createRandomId () {
  return '' + Math.random().toString(36).substr(2, 9);
};

//Adds leading zeros to make result 14 characters long for lexicographical ordering. Only works for integers from 0 to 99999999999999
function integer2LexString(number) {
  let result = ""+number;
  while (result.length < 14) {
    result = "0"+result;
  }
  return result;
}

function connectionsByHost(host) {
  let event2callback = {
    'data': function(data) {},
    'error': function(err) {},
    'close': function() {},
    'end': function() {}
  }
  db.createValueStream({
    gt: connection_by_ip_prefix+host+"/", 
    lt: connection_by_ip_prefix+host+"/"+"z",
  })
  .on('data', function (data) {
    event2callback['data'](data);
  })
  .on('error', function (err) {
    event2callback['err'](err);
  })
  .on('close', function () {
    event2callback['close']();
  })
  .on('end', function () {
    event2callback['end']();
  });

  return {
    on: function(event, callback) {
      event2callback[event] = callback;
      return this;
    }
  }
}  

function connectionsBetween(from, to) {
  let event2callback = {
    'data': function(data) {},
    'error': function(err) {},
    'close': function() {},
    'end': function() {}
  }

  db.createValueStream({
    gt: connection_by_time_prefix+integer2LexString(from), 
    lt: connection_by_time_prefix+integer2LexString(to)
  })
  .on('data', function (data) {
    event2callback['data'](data);
  })
  .on('error', function (err) {
    event2callback['err'](err);
  })
  .on('close', function () {
    event2callback['close']();
  })
  .on('end', function () {
    event2callback['end']();
  });

  return {
    on: function(event, callback) {
      event2callback[event] = callback;
      return this;
    }
  }
}

function recentConnections(duration) {
  let currentTime = (new Date()).getTime();
  return connectionsBetween(currentTime-duration, currentTime);
}


function host2lastAddr(duration) {
  let event2callback = {
    'data': function(data) {},
    'error': function(err) {},
    'close': function() {},
    'end': function() {}
  }
  let currentTime = (new Date()).getTime();
  db.createReadStream({
    gt: host2lastaddr_prefix,
    lt: host2lastaddr_prefix+"z"
  })
  .on('data', function (data) {
    if (duration !== undefined && currentTime-data.value > duration) return;
    event2callback['data'](data);
  })
  .on('error', function (err) {
    event2callback['error'](error);
  })
  .on('close', function () {
    event2callback['close']();
  })
  .on('end', function () {
    event2callback['end']();
  });
  return {
    on: function(event, callback) {
      event2callback[event] = callback;
      return this;
    }
  }
}

function createQueue(callback) {
  const hour = 1000*60*60;
  let host2LastConnectionPromise = new Promise(function(resolve, reject) {
    let host2LastConnection = {};
    recentConnections(hour*3)
    .on('data', function(connection) {
      let key = connection.host+":"+connection.port;
      if (host2LastConnection[key] === undefined || connection.connectTime > host2LastConnection[key].connectTime) {
        host2LastConnection[key] = connection;
      }
    })
    .on('close', function() {
      resolve(host2LastConnection);
    });
  });
  let host2timePromise = new Promise(function(resolve, reject) {
    let host2time = {};
    host2lastAddr(max_age)
    .on('data', function(data) {
        host2time[data.key.substr(host2lastaddr_prefix.length)] = data.value;
    })
    .on('close', function() {
      resolve(host2time);
    });
  });
  Promise.all([host2LastConnectionPromise, host2timePromise]).then(function(values) {
    let host2LastConnection = values[0];
    let host2addrtime = values[1];
    let result = [];
    Object.keys(host2addrtime).forEach(host => {
      let lastAddrTime = host2addrtime[host];
      let currentTime = (new Date()).getTime();
      let nextConnection;
      if (host2LastConnection[host] === undefined) {
        nextConnection = currentTime-lastAddrTime;//connect immediately but give more priority if recent
      } else if (host2LastConnection[host].success) {
        nextConnection = host2LastConnection[host].connectTime+hour*0.5;//every ½ hours
      } else {
        if (lastAddrTime > host2LastConnection[host].connectTime) {
          nextConnection = host2LastConnection[host].connectTime+hour*1;
        } else {
          nextConnection = host2LastConnection[host].connectTime+hour*3;
        }
      }
      let components = host.split(":");
      let ip = components[0];
      let port = components[1];
      result.push({
        host: ip,
        port: port,
        nextConnection: nextConnection
      });
    });
    result.sort((a, b) => a.nextConnection-b.nextConnection);
    callback(result);
  });
}  


function saveConnection(connection, connectionId) {
  update_if_hour_changed();
  add_connection2data(connection);
  const ops = [
    { type: 'put', key: connection_prefix+connectionId, value: connection },
    { type: 'put', key: connection_by_time_prefix+integer2LexString(connection.connectTime)+"/"+connectionId, value: connection },
    { type: 'put', key: connection_by_ip_prefix+connection.host+"/"+integer2LexString(connection.connectTime)+"/"+connectionId, value: connection}
  ];
  db.batch(ops, function (err) {
    if (err) return console.log('Ooops!', err);
  });
}

function connectToPeers() {
  if (paused) return;
  update_if_hour_changed();
  let currentTime = (new Date()).getTime();
  while (failed_connections_queue.length > 0 && currentTime-failed_connections_queue[0] > 1000*60) {
    failed_connections_queue.shift();
  }

  let status = "queue: "+ queue.length+", failed_connections_queue: "+ failed_connections_queue.length+", concurrent_connections: "+concurrent_connections;
  if (queue.length > 0 && queue[0].nextConnection > currentTime) {
    status += ", next action in " + Math.floor((queue[0].nextConnection-currentTime)/1000) + " seconds.";
  }  
  if (status !== status_string) {
    console.log(status);
    status_string = status;
  }

  if (queue.length > 0) {
    let nextActionTime = currentTime-lastConnectTime > 1000*60*1 ? 0 : queue[0].nextConnection;
    if (nextActionTime <= currentTime 
      && concurrent_connections < max_concurrent_connections 
      && failed_connections_queue.length < max_failed_connections_per_minute) {
      let e = queue.shift();
      let host = e.host;
      let port = e.port;
      console.log("connecting to "+host+":"+port);
      concurrent_connections++;
      let connectionId = createRandomId();
      let connectTime = (new Date()).getTime();
      lastConnectTime = connectTime;
      failed_connections_queue.push(connectTime);
      let peer = new p2p.Peer({host: host, port: port, network: network_name, messages: messages});
      let disconnect_called = false;

      let connectionSaved = false;

      let connection = {
        host: peer.host, 
        port: peer.port,
        success:false, 
        connectTime: connectTime
      };

      /*const ops = [
        { type: 'put', key: connection_prefix+connectionId, value: connectionAttempt },
        { type: 'put', key: connection_by_time_prefix+integer2LexString(connectTime)+"/"+connectionId, value: connectionId }
      ];

      db.batch(ops, function (err) {
        if (err) return console.log('Ooops!', err);
      });*/

      let connectTimeout = setTimeout(function() {
        peer.disconnect(); 
      }, connect_timeout);

      let handshakeTimeout;
      let addrTimeout;

      peer.on('connect', function(e) {
        clearTimeout(connectTimeout);
        handshakeTimeout = setTimeout(function() {
          peer.disconnect(); 
        }, handshake_timeout);
      });

      peer.on('version', function(e) {
        peer.services = Number(e.services);
      });

      peer.on('reject', function(e) {
        peer.disconnect();
      });

      peer.on('ready', function() {
        clearTimeout(handshakeTimeout);
        let pos = failed_connections_queue.indexOf(connectTime);
        if (pos > -1) {
          failed_connections_queue.splice(pos, 1);
        }
        let node_network_limited = (peer.services & 1024) !== 0;
        let node_witness = (peer.services & 8) !== 0;
        let node_bloom = (peer.services & 4) !== 0;
        let node_getutxo = (peer.services & 2) !== 0;
        let node_network = (peer.services & 1) !== 0;
		let geo = geoip.lookup(peer.host);
		let city, region, country, regionName, lat, long;
		if (geo) {
			city = geo.city ? geo.city : undefined
			region = geo.region ? geo.region : undefined
			country = countries.getName(geo.country, "en") ? countries.getName(geo.country, "en") : undefined
			lat = geo.ll[0];
			long = geo.ll[1];
		} else {
			city = undefined
			region = undefined
			country = undefined
			lat = undefined
			long = undefined
		}
		if (country){
			if (country == 'United States of America') {
				country = "United States" 
				}
			regionName = regions(country);
			if (regionName) {
				regionName = regionName.regions.filter(obj => {return obj.shortCode === geo.region})
				if (regionName[0]) {
					regionName = regionName[0].name ? regionName[0].name : undefined
				} else {
				    regionName = undefined
				}
			} else {
				regionName = undefined
			}
		}
		let location;
		if (city && regionName && country){location = city + ", " + regionName + ", " + country }
		if (!city && regionName && country){location = regionName + ", " + country }
		if (city && !regionName && country){location = city + ", " + country }
		if (!city && !regionName && country){location = country }
        console.log("connected to ", peer.host+":"+peer.port, peer.version, peer.subversion, peer.bestHeight, peer.services, node_network, node_getutxo, node_bloom, node_witness, node_network_limited);
		let connectedTime = (new Date()).getTime();
        connection = {
          host: peer.host,
          port: peer.port, 
          version: peer.version, 
          subversion: peer.subversion, 
          bestHeight: peer.bestHeight, 
          services: peer.services,
          success:true, 
          connectedTime: connectedTime, 
          connectTime: connectTime,
		  lat: lat,
		  long: long,
		  location: location,
		  country: country,
        };
        if (!connectionSaved) {
          connectionSaved = true;
		  data.active_host++;
		  saveConnection(connection, connectionId);
        }
        /*db.put(connection_prefix+connectionId, connectionSuccess, function (err) {
          if (err) return console.log('Ooops!', err) // some kind of I/O error
        });*/

        
        let getaddr = messages.GetAddr();
        peer.sendMessage(getaddr);

        addrTimeout = setTimeout(function() {
          console.log("No addr message withing "+stay_connected_time/1000+" seconds");
          peer.disconnect(); 
        }, stay_connected_time);
      });
      
      peer.on('error', function(err) {
        clearTimeout(handshakeTimeout);
        clearTimeout(connectTimeout);
        console.log("peer error", err);
        peer.disconnect();
      });
      
      peer.on('disconnect', function() {
        clearTimeout(handshakeTimeout);
        clearTimeout(connectTimeout);
        if (!connectionSaved) {
          connectionSaved = true;
          saveConnection(connection, connectionId);
        }
        if (!disconnect_called) {
          disconnect_called = true;
          concurrent_connections--;
          console.log('connection closed to '+peer.host+":"+peer.port);
        }
      });
      
      peer.on('addr', function(message) {
        console.log(message.addresses.length+" addresses received from "+peer.host+":"+peer.port);
        let addrTimeStamp = (new Date()).getTime();
        let addrMessageId = createRandomId();
        message.addresses.forEach(function(address) {

          let addressId = createRandomId();
          let obj = {connectionId: connectionId, addrMessageId: addrMessageId, timestamp: addrTimeStamp, ip: address.ip, port: address.port, time: address.time.getTime()};
          if (obj.port < 1024 || obj.port > 65535) {
            console.log("INVALID PORT RANGE "+ obj.port+". Ignoring "+address.ip.v4);
            return;
          }
          if (address.ip.v4.startsWith("0.")) {
            console.log(address.ip.v4+" start with 0. Ignoring");
            return;
          }
          if (obj.time > addrTimeStamp+5000) {
            console.log("addr time more than 5 seconds in the future. Ignoring");
            return;
          }

          let key = host2lastaddr_prefix+address.ip.v4+":"+address.port;
          db.get(key, function(err, value) {
            
            const ops = [];
            if (addr_db_ttl === undefined || addr_db_ttl === 0 || Math.max(0, addrTimeStamp-address.time.getTime()) < addr_db_ttl) {
              ops.push({ type: 'put', key: addr_prefix+addressId, value: obj });
              ops.push({ type: 'put', key: addr_by_time_prefix+integer2LexString(address.time.getTime())+"/"+addressId, value: addressId });
            }

            if ((err && err.notFound) || address.time.getTime() > value) {
              ops.push({type: 'put', key: key, value: address.time.getTime()});
            }  
            if (ops.length > 0) {
              db.batch(ops, function (err) {
                if (err) return console.log('Ooops!', err);
              });
            }
          });

        });
        if (message.addresses.length > 20) {
          if (addrTimeout !== undefined) clearTimeout(addrTimeout);
          peer.disconnect();
        }
      });
      peer.connect();
      
    }
  }
  if (queue.length < 250 && currentTime-lastRefreshTime > 1000*15) {
    refreshQueue();
  } else if (queue.length < 500 && currentTime-lastRefreshTime > 1000*30) {//every 30 seconds
    refreshQueue();
  } else if (queue.length < 1000 && currentTime-lastRefreshTime > 1000*60) {//every minute
    refreshQueue();
  } else if (queue.length < 2000 && currentTime-lastRefreshTime > 1000*60*2) {//every 2 minutes
    refreshQueue();
  } else if (queue.length < 4000 && currentTime-lastRefreshTime > 1000*60*4) {//every 4 minutes
    refreshQueue();
  } else if (currentTime-lastRefreshTime > 1000*60*8) {//every 8 minutes
    refreshQueue();
  }
}

function refreshQueue() {
  paused = true;
  createQueue(function(data) {
    if (data.length === 0) {
      queue = [];
      seedNodes.forEach(host => {
		  queue.push({host:host, port: ravencore_lib.Networks.get(network_name).port, nextConnection:0});
	  });
	  
    } else {
      queue = data;
    }  
    console.log("Queue refreshed. New size: "+queue.length);
    paused = false;
    lastRefreshTime = (new Date()).getTime();
  });
}

let removing_addresses = false;

function removeOldAddr() {
  if (removing_addresses) return;
  removing_addresses = true;
  let currentTime = (new Date()).getTime();
  let removeArr = [];
  db.createReadStream({
    gt:addr_by_time_prefix, 
    lt:addr_by_time_prefix+integer2LexString(currentTime-addr_db_ttl), 
    valueEncoding: 'utf8',
    limit: 100000
  })
  .on('data', function (data) {
    let addrId = data.value.replace(/\"/g, "");
    let key = data.key;
    removeArr.push({ type: 'del', key: addr_prefix+addrId });
    removeArr.push({ type: 'del', key: key });

  })
  .on('error', function (err) {
    console.log('Oh my!', err)
  })
  .on('close', function () {
    if (removeArr.length > 0) {
      db.batch(removeArr, function (err) {
        removing_addresses = false;
        if (err) return console.log('Ooops!', err);
      });
    } else {
      removing_addresses = false;
    }
  })
  .on('end', function () {
  });

}

process.on('uncaughtException', (err) => {
  if (!err.toString().startsWith('Error: Unsupported message command')) {
    console.log("unkown err", err);
  }
  console.log("uncaugt ex", err);
});