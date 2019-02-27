const p2p = require('ravencore-p2p');
const express = require('express');
const tableify = require('tableify');
const geoip = require('geoip-lite');
const maxmind = require('maxmind');
const countries = require('i18n-iso-countries');
const regions = require('country-region');
const level = require('level');
const ravencore_lib = require('ravencore-lib');
const networks = require('./networks');
const BitSet = require('bitset');
const fs = require('fs');
const https = require('https');
const targz = require('targz');
let cwd = process.cwd();
let geoliteFile = cwd+'/GeoLite2-ASN_20190219/GeoLite2-ASN.mmdb';

getdl();//gets geolite2
async function getdl() {
	if (!fs.existsSync(geoliteFile)){
	  const getGeoLite = https.get("https://geolite.maxmind.com/download/geoip/database/GeoLite2-ASN.tar.gz", function(response) {
		response.pipe(fs.createWriteStream(cwd+"/GeoLite2-ASN.tar.gz"), { end: false });
		response.on('end', () => {
		  extractFile(cwd+"/GeoLite2-ASN.tar.gz",cwd);
		});
		  });
	} else {
		start();
	}
}

function extractFile(zip,file){
	targz.decompress({
		src: zip,
		dest: file
	}, function(err){
		if(err) {
			console.log(err);
		} else {
			fs.unlinkSync(cwd+"/GeoLite2-ASN.tar.gz");
			start();
		}
	});
}

function start(){
var network_name = "rvn";
let api_port = 3000;
const asnLookup = maxmind.openSync(geoliteFile);
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

let menu = '<nav class="menu">'+
  'Kaaawww Crawler'+
  '<br>'+
  'crawling the ravencoin network for available nodes'+
  '<ul class="menuLinkList">'+
    '<li class="menuLinks">'+
      '<a class="menuLink" href="javascript:gotoURL(\'map\')">Map</a>'+
    '</li>'+
	'<li class="menuDivider">|</li>'+
    '<li class="menuLinks">'+
      '<a class="menuLink" href="javascript:gotoURL(\'node_list\')">List</a>'+
    '</li>'+
  '</ul>'+
'</nav>';

let menuCSS = ".menu {"+
  "mask-image: linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, #ffffff 25%, #ffffff 75%, rgba(255, 255, 255, 0) 100%);"+
  "margin: 0 auto;"+
  "padding: 0px 0;"+
  "position: absolute;"+
  "top: 0px;"+
  "width: 100%;"+
  "overflow: hidden;"+
  "color: #696969;"+
  "text-align: center;"+
"}"+
".menu .menuLinkList {"+
  "text-align: center;"+
  "padding: 0;"+
  "background: linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.2) 25%, rgba(255, 255, 255, 0.2) 75%, rgba(255, 255, 255, 0) 100%);"+
  "box-shadow: 0 0 25px rgba(0, 0, 0, 0.1), inset 0 0 1px rgba(255, 255, 255, 0.6);"+
"}"+
".menu .menuLinkList .menuLinks {"+
  "display: inline-block;"+
"}"+
".menu .menuLinkList .menuLinks .menuLink {"+
  "padding: 5px 10px;"+
  "color: #696969;"+
  "text-shadow: 1px 1px 1px #696969;"+
  "font-size: 30px;"+
  "text-decoration: none;"+
  "display: block;"+
  "background: transparent;"+
  "border: transparent;"+
"}"+
".menu .menuLinkList .menuLinks .menuLink:hover {"+
  "box-shadow: 0 0 10px rgba(0, 0, 0, 0.1), inset 0 0 1px rgba(255, 255, 255, 0.6);"+
  "background: rgba(255, 255, 255, 0.1);"+
  "color: rgba(0, 0, 0, 0.7);"+
"}"+
".menuDivider {"+
    "padding: 5px 10px;"+
    "color: #696969;"+
    "text-shadow: 1px 1px 1px #696969;"+
    "font-size: 30px;"+
    "text-decoration: none;"+
    "display: block;"+
    "background: transparent;"+
    "border: transparent;"+
    "display: inline-block;"+
"}";

let gotoURL = 'function gotoURL(page) {'+
'open(location.origin+"/"+page,"_self");'+
'}';

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

let data = {
  epoch_hour: 0,
  hour2first_and_last_connection_time: {},
  hostdata: {
    host2active: {},
    host2lastconnection: {}
  }
};

let shifting_data = false;

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
let removing_addresses = false;

//webpage rendering
var app = express();

app.get('/', function (req, res) {
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
		let css = "<head><script>"+gotoURL+"</script><style>body {  background: #000; } "+
		menuCSS+".menu{position:inherit}"+
		"div.home {"+
    "margin-top: 60px;"+
    "padding: 10px;"+
		"font-size: large;"+
		"text-align: center;"+
    "background-color: #333;"+
		"color: #696969;"+
    "-webkit-border-radius: 6px;"+
    "-moz-border-radius: 6px;"+
    "border-radius: 6px;"+
		"}a{color: #7a7a7a;}"+
		"</style></head>";
		let home = "<div class='home'>"+
        "<h3>What is Kaaawww crawler?</h3>"+
        "<p><a href='https://github.com/raven-community/kaaawww-crawler'>kaaawww crawler</a>"+
				" is based off of <a href='https://github.com/jeroz1/Ravennodes'>Ravennodes(Python)</a>"+
				" this version is in javascript, it estimates<br> the size of the Ravencoin network by finding"+
				" all the <b>reachable nodes</b> These are the nodes that accept incoming connections.<br>"+
				" This method will not list all full nodes because not all nodes have an open port that can be"+
        "probed using Kaaawww crawler.<br> These nodes are either behind firewalls or configured to not listen for connections.</p>"+
    "</div>";
    res.send(
			css+
			"<body>"+
		 menu+
		 home+
		 "</body>"
    );
  });
});

app.get('/charts/bar', function(req, res) {
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
		let hostList = Object.keys(host2lastconnection).filter(host => host2lastconnection[host].success);
		let hostData = Object.values(host2lastconnection).filter(obj => {return obj.success === true});
		let hostCount = hostList.length;
		let subversion = [];
		let country = [];
		let isp = [];
		hostData = hostData.map(obj => ({
			subversion: obj.subversion,
			country: obj.country,
			isp: obj.isp
		}));
		for(i=0;i<hostCount;i++){
			subversion.push(hostData[i].subversion.split(":").pop().match(/[+-]?\d+(?:\.\d+)(?:\.\d+)?/g).pop());
			country.push(hostData[i].country);
			isp.push(hostData[i].isp);
		}
		subversion = subversion.sort( (a, b) => b.localeCompare(a, undefined, { numeric:true }) );
		country = country.sort();
		isp = isp.sort();
		let subversionCount = {};
		let subversionList = {}
		let countryCount = {};
		let countryList = {};
		let ispCount = {};
		let ispList = {};
		let allinfo = {
			count: {
				subversion: 0,
				country: 0,
				isp: 0
			}
		};
    subversion.forEach(function(i) {
			 subversionCount[i] = (subversionCount[i]||0) + 1;
			 subversionList[i] = {};
			 subversionList[i].count = (subversionCount[i]||0) + 1;
		});
		country.forEach(function(i) {
			 countryCount[i] = (countryCount[i]||0) + 1;
			 countryList[i] = {};
			 countryList[i].count = (countryCount[i]||0) + 1;
		});
    isp.forEach(function(i) {
			 ispCount[i] = (ispCount[i]||0) + 1;
			 ispList[i] = {};
			 ispList[i].count = (ispCount[i]||0) + 1;
		 });
		 let subversionListSorted = {};
		 let countryListSorted = {};
		 let ispListSorted = {};
		 Object.keys(subversionList)
		 		.map(key => ({ key: key, value: subversionList[key] }))
		 		.sort((first, second) => (first.value.count > second.value.count) ? -1 : (first.value.count < second.value.count) ? 1 : 0 )
				.forEach((sortedData) => subversionListSorted[sortedData.key] = (JSON.parse(JSON.stringify(sortedData)
					.replace('{"key":"'+sortedData.key+'"','')
					.replace(',"value":','')
					.slice(0, -1)
				)));
			Object.keys(countryList)
				 .map(key => ({ key: key, value: countryList[key] }))
				 .sort((first, second) => (first.value.count > second.value.count) ? -1 : (first.value.count < second.value.count) ? 1 : 0 )
				 .forEach((sortedData) => countryListSorted[sortedData.key] = (JSON.parse(JSON.stringify(sortedData)
					 .replace('{"key":"'+sortedData.key+'"','')
					 .replace(',"value":','')
					 .slice(0, -1)
				 )));
			 Object.keys(ispList)
	 			 .map(key => ({ key: key, value: ispList[key] }))
	 			 .sort((first, second) => (first.value.count > second.value.count) ? -1 : (first.value.count < second.value.count) ? 1 : 0 )
	 			 .forEach((sortedData) => ispListSorted[sortedData.key] = (JSON.parse(JSON.stringify(sortedData)
	 				 .replace('{"key":"'+sortedData.key+'"','')
	 				 .replace(',"value":','')
	 				 .slice(0, -1)
	 			 )));
		for (i in subversionCount){
			allinfo.count.subversion = allinfo.count.subversion + subversionCount[i]
		}
		for (i in countryCount){
			allinfo.count.country = allinfo.count.country + countryCount[i]
		}
		for (i in ispCount){
			allinfo.count.isp = allinfo.count.isp + ispCount[i]
		}
		for (i in subversionListSorted) {
				let fixed = (subversionListSorted[i].count / allinfo.count.subversion) * 100;
				fixed = fixed.toFixed(2)
				subversionListSorted[i].percent = fixed;
		};
		for (i in countryListSorted) {
				let fixed = (countryListSorted[i].count / allinfo.count.country) * 100;
				fixed = fixed.toFixed(2)
				countryListSorted[i].percent = fixed;
		};
		for (i in ispListSorted) {
				let fixed = (ispListSorted[i].count / allinfo.count.isp) * 100;
				fixed = fixed.toFixed(2)
				ispListSorted[i].percent = fixed;
		};
		let subversionListKeys = [];
		let subversionListValues = [];
		let countryListKeys = [];
		let countryListValues = [];
		let ispListKeys = [];
		let ispListValues = [];
		for (i in subversionListSorted){
				subversionListKeys.push('"'+i+'"')
				subversionListValues.push(subversionListSorted[i]['count'])
		}
		for (i in countryListSorted){
			countryListKeys.push('"'+i+'"')
			countryListValues.push(countryListSorted[i]['count'])
		}
		for (i in ispListSorted){
			ispListKeys.push('"'+i+'"')
			ispListValues.push(ispListSorted[i]['count'])
		}
		allinfo.subversion = subversionListSorted;
		allinfo.country = countryListSorted;
		allinfo.isp = ispListSorted;
		let html = "<head>"+
			"<style>"+
			"body {  background: #000; }"+
			" table {  text-align: left;  margin: auto; }"+
			" table td, table th {  border: 3px solid #9d9d9d;  padding: 5px 2px; }"+
			" table tbody td, table tbody th {  color: #9D9D9D; }"+
			" table tr:nth-child(even) {  background: black;  border: 3px solid #9d9d9d; }"+
			" table tbody tr {  background: #000;  border: 3px solid #5d4343; }"+
			" table thead tr {  background: #9d9d9d; }"+
			" table thead th {  font-size: 20px;  font-weight: bold;  color: #000;  text-align: left; }"+
			" table tfoot {  font-size: 13px;  font-weight: bold;  color: #FFFFFF;  background: #CE3CFF;  background: -moz-linear-gradient(top, #da6dff 0%, #d34fff 66%, #CE3CFF 100%);  background: -webkit-linear-gradient(top, #da6dff 0%, #d34fff 66%, #CE3CFF 100%);  background: linear-gradient(to bottom, #da6dff 0%, #d34fff 66%, #CE3CFF 100%);  border-top: 5px solid #792396; }"+
			" table tfoot td {  font-size: 13px; }"+
			" table tfoot .links {  text-align: right; }"+
			" table tfoot .links a {  display: inline-block;  background: #792396;  color: #FFFFFF;  padding: 2px 8px;  border-radius: 5px; }"+
			" table tbody tr:hover, table tbody td:hover {  background: #005107; }"+
			menuCSS+
			" .menu { position: inherit; }</style>"+
			"</style>"+
			"<script>"+gotoURL+"</script>"+
			"<script src='https://cdn.plot.ly/plotly-latest.min.js'></script>"+
  		"<script src='https://cdnjs.cloudflare.com/ajax/libs/numeric/1.2.6/numeric.min.js'></script>"+
			"</head>"+
			"<body>"+
			menu+
			"<div id='version-table'>"+
			"</div>"+
			"<script>"+
			"var myPlot = document.getElementById('version-table');"+
			"var layout = {"+
			  "showlegend: true,"+
			  "legend: {orientation: 'h',x:0,y:-0.5},"+
	      "plot_bgcolor:'#000',"+
				"constraintext: 'inside',"+
	      "paper_bgcolor:'#000',"+
				"xaxis: {"+
			    "tickangle: -20"+
			  "}"+
			"};"+
			"var data = [{"+
			  `y: [${subversionListValues}],`+
			  `x: [${subversionListKeys}],`+
			  "type: 'bar',"+
				"legendgroup: 'group1',"+
				"hoverinfo: 'x+y',"+
				"textposition: 'auto',"+
				`text: [${subversionListValues}].map(String),`+
				"name: 'Subversions',"+
				"marker: {"+
			    "color: 'rgba(69, 90, 210, .7)',"+
			    "opacity: 0.6,"+
			    "line: {"+
			      "color: 'rgb(165, 0, 0)',"+
			      "width: 1.5"+
			    "}"+
			  "},"+
				"textfont: {color:'#696969'},"+
				"outsidetextfont : {color:'#696969'},"+
				"insidetextfont: {color:'#696969'}"+
			"},"+
			"{"+
			  `y: [${countryListValues.slice(0,10)}],`+
			  `x: [${countryListKeys.slice(0,10)}],`+
			  "type: 'bar',"+
				"legendgroup: 'group2',"+
				"hoverinfo: 'x+y',"+
				"textposition: 'auto',"+
				`text: [${countryListValues}].map(String),`+
				"name: 'Countries',"+
				"marker: {"+
			    "color: 'rgba(107, 114, 113, .7)',"+
			    "opacity: 0.6,"+
			    "line: {"+
			      "color: 'rgb(165, 0, 0)',"+
			      "width: 1.5"+
			    "}"+
			  "},"+
				"textfont: {color:'#696969'},"+
				"outsidetextfont : {color:'#696969'},"+
				"insidetextfont: {color:'#696969'}"+
			"},"+
			"{"+
			  `y: [${ispListValues.slice(0,10)}],`+
			  `x: [${ispListKeys.slice(0,10)}],`+
			  "type: 'bar',"+
				"legendgroup: 'group3',"+
				"hoverinfo: 'x+y',"+
				"textposition: 'auto',"+
				`text: [${ispListValues}].map(String),`+
				"name: 'ISP',"+
				"marker: {"+
			    "color: 'rgba(165, 69, 209, .7)',"+//69, 90, 210
			    "opacity: 0.6,"+
			    "line: {"+
			      "color: 'rgb(165, 0, 0)',"+
			      "width: 1.5"+
			    "}"+
			  "},"+
				"textfont: {color:'#696969'},"+
				"outsidetextfont : {color:'#696969'},"+
				"insidetextfont: {color:'#696969'}"+
			"}];"+
			"Plotly.newPlot(myPlot, data, layout, {responsive: true,displaylogo: false,"+
			"modeBarButtonsToRemove: ['zoom2d','pan2d','select2d','lasso2d','zoomIn2d','zoomOut2d','autoScale2d','toggleSpikelines','hoverCompareCartesian','hoverClosestCartesian']});"+
			"myPlot.on('plotly_legendclick',function() { return false; });"+
			"</script>"+
			"</body>";
		res.send(
			html
		);
	});
});

app.get('/charts/pie', function(req, res) {
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
		let hostList = Object.keys(host2lastconnection).filter(host => host2lastconnection[host].success);
		let hostData = Object.values(host2lastconnection).filter(obj => {return obj.success === true});
		let hostCount = hostList.length;
		let subversion = [];
		let country = [];
		let isp = [];
		hostData = hostData.map(obj => ({
			subversion: obj.subversion,
			country: obj.country,
			isp: obj.isp
		}));
		for(i=0;i<hostCount;i++){
			subversion.push(hostData[i].subversion.split(":").pop().match(/[+-]?\d+(?:\.\d+)(?:\.\d+)?/g).pop());
			country.push(hostData[i].country);
			isp.push(hostData[i].isp);
		}
		subversion = subversion.sort( (a, b) => b.localeCompare(a, undefined, { numeric:true }) );
		country = country.sort();
		isp = isp.sort();
		let subversionCount = {};
		let subversionList = {}
		let countryCount = {};
		let countryList = {};
		let ispCount = {};
		let ispList = {};
		let allinfo = {
			count: {
				subversion: 0,
				country: 0,
				isp: 0
			}
		};
    subversion.forEach(function(i) {
			 subversionCount[i] = (subversionCount[i]||0) + 1;
			 subversionList[i] = {};
			 subversionList[i].count = (subversionCount[i]||0) + 1;
		});
		country.forEach(function(i) {
			 countryCount[i] = (countryCount[i]||0) + 1;
			 countryList[i] = {};
			 countryList[i].count = (countryCount[i]||0) + 1;
		});
    isp.forEach(function(i) {
			 ispCount[i] = (ispCount[i]||0) + 1;
			 ispList[i] = {};
			 ispList[i].count = (ispCount[i]||0) + 1;
		 });
		 let subversionListSorted = {};
		 let countryListSorted = {};
		 let ispListSorted = {};
		 Object.keys(subversionList)
		 		.map(key => ({ key: key, value: subversionList[key] }))
		 		.sort((first, second) => (first.value.count > second.value.count) ? -1 : (first.value.count < second.value.count) ? 1 : 0 )
				.forEach((sortedData) => subversionListSorted[sortedData.key] = (JSON.parse(JSON.stringify(sortedData)
					.replace('{"key":"'+sortedData.key+'"','')
					.replace(',"value":','')
					.slice(0, -1)
				)));
			Object.keys(countryList)
				 .map(key => ({ key: key, value: countryList[key] }))
				 .sort((first, second) => (first.value.count > second.value.count) ? -1 : (first.value.count < second.value.count) ? 1 : 0 )
				 .forEach((sortedData) => countryListSorted[sortedData.key] = (JSON.parse(JSON.stringify(sortedData)
					 .replace('{"key":"'+sortedData.key+'"','')
					 .replace(',"value":','')
					 .slice(0, -1)
				 )));
			 Object.keys(ispList)
	 			 .map(key => ({ key: key, value: ispList[key] }))
	 			 .sort((first, second) => (first.value.count > second.value.count) ? -1 : (first.value.count < second.value.count) ? 1 : 0 )
	 			 .forEach((sortedData) => ispListSorted[sortedData.key] = (JSON.parse(JSON.stringify(sortedData)
	 				 .replace('{"key":"'+sortedData.key+'"','')
	 				 .replace(',"value":','')
	 				 .slice(0, -1)
	 			 )));
		for (i in subversionCount){
			allinfo.count.subversion = allinfo.count.subversion + subversionCount[i]
		}
		for (i in countryCount){
			allinfo.count.country = allinfo.count.country + countryCount[i]
		}
		for (i in ispCount){
			allinfo.count.isp = allinfo.count.isp + ispCount[i]
		}
		for (i in subversionListSorted) {
				let fixed = (subversionListSorted[i].count / allinfo.count.subversion) * 100;
				fixed = fixed.toFixed(2)
				subversionListSorted[i].percent = fixed;
		};
		for (i in countryListSorted) {
				let fixed = (countryListSorted[i].count / allinfo.count.country) * 100;
				fixed = fixed.toFixed(2)
				countryListSorted[i].percent = fixed;
		};
		for (i in ispListSorted) {
				let fixed = (ispListSorted[i].count / allinfo.count.isp) * 100;
				fixed = fixed.toFixed(2)
				ispListSorted[i].percent = fixed;
		};
		let subversionListKeys = [];
		let subversionListValues = [];
		let countryListKeys = [];
		let countryListValues = [];
		let ispListKeys = [];
		let ispListValues = [];
		for (i in subversionListSorted){
				subversionListKeys.push('"'+i+'('+subversionListSorted[i]['count']+')"')
				subversionListValues.push(subversionListSorted[i]['count'])
		}
		for (i in countryListSorted){
			countryListKeys.push('"'+i+'('+countryListSorted[i]['count']+')"')
			countryListValues.push(countryListSorted[i]['count'])
		}
		for (i in ispListSorted){
			ispListKeys.push('"'+i+'('+ispListSorted[i]['count']+')"')
			ispListValues.push(ispListSorted[i]['count'])
		}
		allinfo.subversion = subversionListSorted;
		allinfo.country = countryListSorted;
		allinfo.isp = ispListSorted;
		let html = "<head>"+
			"<style>"+
			"body {  background: #000; }"+
			" table {  text-align: left;  margin: auto; }"+
			" table td, table th {  border: 3px solid #9d9d9d;  padding: 5px 2px; }"+
			" table tbody td, table tbody th {  color: #9D9D9D; }"+
			" table tr:nth-child(even) {  background: black;  border: 3px solid #9d9d9d; }"+
			" table tbody tr {  background: #000;  border: 3px solid #5d4343; }"+
			" table thead tr {  background: #9d9d9d; }"+
			" table thead th {  font-size: 20px;  font-weight: bold;  color: #000;  text-align: left; }"+
			" table tfoot {  font-size: 13px;  font-weight: bold;  color: #FFFFFF;  background: #CE3CFF;  background: -moz-linear-gradient(top, #da6dff 0%, #d34fff 66%, #CE3CFF 100%);  background: -webkit-linear-gradient(top, #da6dff 0%, #d34fff 66%, #CE3CFF 100%);  background: linear-gradient(to bottom, #da6dff 0%, #d34fff 66%, #CE3CFF 100%);  border-top: 5px solid #792396; }"+
			" table tfoot td {  font-size: 13px; }"+
			" table tfoot .links {  text-align: right; }"+
			" table tfoot .links a {  display: inline-block;  background: #792396;  color: #FFFFFF;  padding: 2px 8px;  border-radius: 5px; }"+
			" table tbody tr:hover, table tbody td:hover {  background: #005107; }"+
			menuCSS+
			" .menu { position: inherit; }</style>"+
			"</style>"+
			"<script>"+gotoURL+"</script>"+
			"<script src='https://cdn.plot.ly/plotly-latest.min.js'></script>"+
  		"<script src='https://cdnjs.cloudflare.com/ajax/libs/numeric/1.2.6/numeric.min.js'></script>"+
			"</head>"+
			"<body>"+
			menu+
			"<div id='version-table'>"+
			"</div>"+
			"<script>"+
			"var myPlot = document.getElementById('version-table');"+
			"var layout = {"+
			  "showlegend: true,"+
			  "legend: {orientation: 'v'},"+
	      "plot_bgcolor:'#000',"+
	      "paper_bgcolor:'#000',"+
				"grid: {rows: 1, columns: 3},"+
				"annotations: ["+
			    "{"+
			      "font: {"+
			        "size: 20"+
			      "},"+
			      "showarrow: false,"+
						"x: .11,"+
      			"y: 0.5,"+
			      "text: 'Top 10<br>Versions'"+
			    "},"+
					"{"+
						"font: {"+
							"size: 20"+
						"},"+
						"showarrow: false,"+
						"text: 'Top 10<br>Countries'"+
					"},"+
			    "{"+
			      "font: {"+
			        "size: 20"+
			      "},"+
			      "showarrow: false,"+
						"x: 0.88,"+
			      "y: 0.5,"+
			      "text: 'Top 10<br>ISP'"+
			    "}"+
			  "]"+
			"};"+
			"var data = [{"+
			  `values: [${subversionListValues}],`+
			  `labels: [${subversionListKeys}],`+
			  "type: 'pie',"+
				"hole: .5,"+
				"legendgroup: 'group1',"+
				"hoverinfo: 'label+percent',"+
				"textinfo: 'percent',"+
				"textposition: 'auto',"+
				"textfont: {color:'#696969'},"+
				"outsidetextfont : {color:'#696969'},"+
				"insidetextfont: {color:'#000'},"+
				"domain: {"+
			    "row: 0,"+
			    "column: 0"+
			  "}"+
			"},"+
			"{"+
			  `values: [${countryListValues.slice(0,10)}],`+
			  `labels: [${countryListKeys.slice(0,10)}],`+
			  "type: 'pie',"+
				"hole: .5,"+
				"legendgroup: 'group2',"+
				"hoverinfo: 'label+percent',"+
				"textinfo: 'percent',"+
				"textposition: 'auto',"+
				"textfont: {color:'#696969'},"+
				"outsidetextfont : {color:'#696969'},"+
				"insidetextfont: {color:'#000'},"+
				"domain: {"+
			    "row: 0,"+
			    "column: 1"+
			  "}"+
			"},"+
			"{"+
			  `values: [${ispListValues.slice(0,10)}],`+
			  `labels: [${ispListKeys.slice(0,10)}],`+
			  "type: 'pie',"+
				"hole: .5,"+
				"legendgroup: 'group3',"+
				"hoverinfo: 'label+percent',"+
				"textinfo: 'percent',"+
				"textposition: 'auto',"+
				"textfont: {color:'#696969'},"+
				"outsidetextfont : {color:'#696969'},"+
				"insidetextfont: {color:'#000'},"+
				"domain: {"+
			    "row: 0,"+
			    "column: 2"+
			  "}"+
			"}];"+
			"Plotly.newPlot(myPlot, data, layout, {responsive: true,displaylogo: false});"+
			"myPlot.on('plotly_legendclick',function() { return false; });"+
			"</script>"+
			"</body>";
		res.send(
			html
		);
	});
});

app.get('/charts/table', function(req, res) {
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
		let hostList = Object.keys(host2lastconnection).filter(host => host2lastconnection[host].success);
		let hostData = Object.values(host2lastconnection).filter(obj => {return obj.success === true});
		let hostCount = hostList.length;
		let subversion = [];
		let country = [];
		let isp = [];
		hostData = hostData.map(obj => ({
			subversion: obj.subversion,
			country: obj.country,
			isp: obj.isp
		}));
		for(i=0;i<hostCount;i++){
			subversion.push(hostData[i].subversion.split(":").pop().match(/[+-]?\d+(?:\.\d+)(?:\.\d+)?/g).pop());
			country.push(hostData[i].country);
			isp.push(hostData[i].isp);
		}
		subversion = subversion.sort( (a, b) => b.localeCompare(a, undefined, { numeric:true }) );
		country = country.sort();
		isp = isp.sort();
		let subversionCount = {};
		let subversionList = {}
		let countryCount = {};
		let countryList = {};
		let ispCount = {};
		let ispList = {};
		let allinfo = {
			count: {
				subversion: 0,
				country: 0,
				isp: 0
			}
		};
    subversion.forEach(function(i) {
			 subversionCount[i] = (subversionCount[i]||0) + 1;
			 subversionList[i] = {};
			 subversionList[i].count = (subversionCount[i]||0) + 1;
		});
		country.forEach(function(i) {
			 countryCount[i] = (countryCount[i]||0) + 1;
			 countryList[i] = {};
			 countryList[i].count = (countryCount[i]||0) + 1;
		});
    isp.forEach(function(i) {
			 ispCount[i] = (ispCount[i]||0) + 1;
			 ispList[i] = {};
			 ispList[i].count = (ispCount[i]||0) + 1;
		 });
		 let subversionListSorted = {};
		 let countryListSorted = {};
		 let ispListSorted = {};
		 Object.keys(subversionList)
		 		.map(key => ({ key: key, value: subversionList[key] }))
		 		.sort((first, second) => (first.value.count > second.value.count) ? -1 : (first.value.count < second.value.count) ? 1 : 0 )
				.forEach((sortedData) => subversionListSorted[sortedData.key] = (JSON.parse(JSON.stringify(sortedData)
					.replace('{"key":"'+sortedData.key+'"','')
					.replace(',"value":','')
					.slice(0, -1)
				)));
			Object.keys(countryList)
				 .map(key => ({ key: key, value: countryList[key] }))
				 .sort((first, second) => (first.value.count > second.value.count) ? -1 : (first.value.count < second.value.count) ? 1 : 0 )
				 .forEach((sortedData) => countryListSorted[sortedData.key] = (JSON.parse(JSON.stringify(sortedData)
					 .replace('{"key":"'+sortedData.key+'"','')
					 .replace(',"value":','')
					 .slice(0, -1)
				 )));
			 Object.keys(ispList)
	 			 .map(key => ({ key: key, value: ispList[key] }))
	 			 .sort((first, second) => (first.value.count > second.value.count) ? -1 : (first.value.count < second.value.count) ? 1 : 0 )
	 			 .forEach((sortedData) => ispListSorted[sortedData.key] = (JSON.parse(JSON.stringify(sortedData)
	 				 .replace('{"key":"'+sortedData.key+'"','')
	 				 .replace(',"value":','')
	 				 .slice(0, -1)
	 			 )));
		for (i in subversionCount){
			allinfo.count.subversion = allinfo.count.subversion + subversionCount[i]
		}
		for (i in countryCount){
			allinfo.count.country = allinfo.count.country + countryCount[i]
		}
		for (i in ispCount){
			allinfo.count.isp = allinfo.count.isp + ispCount[i]
		}
		for (i in subversionListSorted) {
				let fixed = (subversionListSorted[i].count / allinfo.count.subversion) * 100;
				fixed = fixed.toFixed(2)
				subversionListSorted[i].percent = fixed;
		};
		for (i in countryListSorted) {
				let fixed = (countryListSorted[i].count / allinfo.count.country) * 100;
				fixed = fixed.toFixed(2)
				countryListSorted[i].percent = fixed;
		};
		for (i in ispListSorted) {
				let fixed = (ispListSorted[i].count / allinfo.count.isp) * 100;
				fixed = fixed.toFixed(2)
				ispListSorted[i].percent = fixed;
		};
		let subversionListKeys = [];
		let subversionListValues = [];
		let subversionListPercents = [];
		let countryListKeys = [];
		let countryListValues = [];
		let countryListPercents = [];
		let ispListKeys = [];
		let ispListValues = [];
		let ispListPercents = [];
		for (i in subversionListSorted){
				subversionListKeys.push('"'+i+'"')
				subversionListValues.push(subversionListSorted[i]['count'])
				subversionListPercents.push(subversionListSorted[i]['percent'])
		}
		for (i in countryListSorted){
			countryListKeys.push('"'+i+'"')
			countryListValues.push(countryListSorted[i]['count'])
			countryListPercents.push(countryListSorted[i]['percent'])
		}
		for (i in ispListSorted){
			ispListKeys.push('"'+i+'"')
			ispListValues.push(ispListSorted[i]['count'])
			ispListPercents.push(ispListSorted[i]['percent'])
		}
		allinfo.subversion = subversionListSorted;
		allinfo.country = countryListSorted;
		allinfo.isp = ispListSorted;
		let html = "<head>"+
			"<style>"+
			"body {  background: #000; }"+
			" table {  text-align: left;  margin: auto; }"+
			" table td, table th {  border: 3px solid #9d9d9d;  padding: 5px 2px; }"+
			" table tbody td, table tbody th {  color: #9D9D9D; }"+
			" table tr:nth-child(even) {  background: black;  border: 3px solid #9d9d9d; }"+
			" table tbody tr {  background: #000;  border: 3px solid #5d4343; }"+
			" table thead tr {  background: #9d9d9d; }"+
			" table thead th {  font-size: 20px;  font-weight: bold;  color: #000;  text-align: left; }"+
			" table tfoot {  font-size: 13px;  font-weight: bold;  color: #FFFFFF;  background: #CE3CFF;  background: -moz-linear-gradient(top, #da6dff 0%, #d34fff 66%, #CE3CFF 100%);  background: -webkit-linear-gradient(top, #da6dff 0%, #d34fff 66%, #CE3CFF 100%);  background: linear-gradient(to bottom, #da6dff 0%, #d34fff 66%, #CE3CFF 100%);  border-top: 5px solid #792396; }"+
			" table tfoot td {  font-size: 13px; }"+
			" table tfoot .links {  text-align: right; }"+
			" table tfoot .links a {  display: inline-block;  background: #792396;  color: #FFFFFF;  padding: 2px 8px;  border-radius: 5px; }"+
			" table tbody tr:hover, table tbody td:hover {  background: #005107; }"+
			menuCSS+
			" .menu { position: inherit; }</style>"+
			"</style>"+
			"<script>"+gotoURL+"</script>"+
			"<script src='https://cdn.plot.ly/plotly-latest.min.js'></script>"+
  		"<script src='https://cdnjs.cloudflare.com/ajax/libs/numeric/1.2.6/numeric.min.js'></script>"+
			"</head>"+
			"<body>"+
			menu+
			"<div id='version-table'>"+
			"</div>"+
			"<script>"+
			"var myPlot = document.getElementById('version-table');"+
			"var layout = {"+
	      "paper_bgcolor:'#000',"+
				"grid: {rows: 1, columns: 3},"+
				"title: {"+
			    "text:'Top 10 Versions                    "+
					"                 "+
					"Top 10 Countries                   "+
					"                 "+
					"Top 10 ISP',"+
			    "font: {"+
						"color: '#696969',"+
			      "size: 24"+
			    "},"+
			    "xref: 'paper'"+
			  "}"+
			"};"+
			"var data = [{"+
				"header: {"+
			    "values: [['Version'],['Count'],['Percent']],"+
					"align: 'center',"+
			    "line: {width: 1, color: 'black'},"+
			    "fill: {color: '#333'},"+
			    "font: {family: 'Arial', size: 14, color: '#696969'}"+
			  "},"+
				"cells: {"+
			    `values: [[${subversionListKeys}],[${subversionListValues}],[${subversionListPercents}]],`+
			    "align: 'center',"+
			    "line: {color: 'black', width: 1},"+
					"fill: {color: '#696969'},"+
			    "font: {family: 'Arial', size: 13, color: ['#333']}"+
			  "},"+
			  "type: 'table',"+
				"columnwidth: [20,5,5],"+
				"legendgroup: 'group1',"+
				"domain: {"+
			    "row: 0,"+
			    "column: 0"+
			  "}"+
			"},"+
			"{"+
			"header: {"+
				"values: [['Countries'],['Count'],['Percent']],"+
				"align: 'center',"+
				"line: {width: 1, color: 'black'},"+
				"fill: {color: '#333'},"+
				"font: {family: 'Arial', size: 14, color: '#696969'}"+
			"},"+
			"cells: {"+
				`values: [[${countryListKeys.slice(0,10)}],[${countryListValues.slice(0,10)}],[${countryListPercents.slice(0,10)}]],`+
				"align: ['center','center','center'],"+
				"line: {color: 'black', width: 1},"+
				"fill: {color: '#696969'},"+
				"font: {family: 'Arial', size: 13, color: ['#333']}"+
			"},"+
			  "type: 'table',"+
				"columnwidth: [10,5,5],"+
				"legendgroup: 'group2',"+
				"domain: {"+
			    "row: 0,"+
			    "column: 1"+
			  "}"+
			"},"+
			"{"+
				"header: {"+
					"values: [['ISP'],['Count'],['Percent']],"+
					"align: 'center',"+
					"line: {width: 1, color: 'black'},"+
					"fill: {color: '#333'},"+
					"font: {family: 'Arial', size: 14, color: '#696969'}"+
				"},"+
				"cells: {"+
					`values: [[${ispListKeys.slice(0,10)}],[${ispListValues.slice(0,10)}],[${ispListPercents.slice(0,10)}]],`+
					"align: 'center',"+
					"line: {color: 'black', width: 1},"+
					"fill: {color: '#696969'},"+
					"font: {family: 'Arial', size: 13, color: ['#333']}"+
				"},"+
			  "type: 'table',"+
				"columnwidth: [15,3,3],"+
				"legendgroup: 'group3',"+
				"domain: {"+
			    "row: 0,"+
			    "column: 2"+
			  "}"+
			"}];"+
			"Plotly.newPlot(myPlot, data, layout, {responsive: true,displaylogo: false});"+
			"</script>"+
			"</body>";
		res.send(
			html
		);
	});
});

app.get('/api', function(req, res) {
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
		let hostList = Object.keys(host2lastconnection).filter(host => host2lastconnection[host].success);
		let hostData = Object.values(host2lastconnection).filter(obj => {return obj.success === true});
		let hostCount = hostList.length;
		let subversion = [];
		let country = [];
		let isp = [];
		hostData = hostData.map(obj => ({
			subversion: obj.subversion,
			country: obj.country,
			isp: obj.isp
		}));
		for(i=0;i<hostCount;i++){
			subversion.push(hostData[i].subversion.split(":").pop().match(/[+-]?\d+(?:\.\d+)(?:\.\d+)?/g).pop());
			country.push(hostData[i].country);
			isp.push(hostData[i].isp);
		}
		subversion = subversion.sort( (a, b) => b.localeCompare(a, undefined, { numeric:true }) );
		country = country.sort();
		isp = isp.sort();
		let subversionCount = {};
		let subversionList = {}
		let countryCount = {};
		let countryList = {};
		let ispCount = {};
		let ispList = {};
		let allinfo = {
			count: {
				subversion: 0,
				country: 0,
				isp: 0
			}
		};
    subversion.forEach(function(i) {
			 subversionCount[i] = (subversionCount[i]||0) + 1;
			 subversionList[i] = {};
			 subversionList[i].count = (subversionCount[i]||0) + 1;
		});
		country.forEach(function(i) {
			 countryCount[i] = (countryCount[i]||0) + 1;
			 countryList[i] = {};
			 countryList[i].count = (countryCount[i]||0) + 1;
		});
    isp.forEach(function(i) {
			 ispCount[i] = (ispCount[i]||0) + 1;
			 ispList[i] = {};
			 ispList[i].count = (ispCount[i]||0) + 1;
		 });
		 let subversionListSorted = {};
		 let countryListSorted = {};
		 let ispListSorted = {};
		 Object.keys(subversionList)
		 		.map(key => ({ key: key, value: subversionList[key] }))
		 		.sort((first, second) => (first.value.count > second.value.count) ? -1 : (first.value.count < second.value.count) ? 1 : 0 )
				.forEach((sortedData) => subversionListSorted[sortedData.key] = (JSON.parse(JSON.stringify(sortedData)
					.replace('{"key":"'+sortedData.key+'"','')
					.replace(',"value":','')
					.slice(0, -1)
				)));
			Object.keys(countryList)
				 .map(key => ({ key: key, value: countryList[key] }))
				 .sort((first, second) => (first.value.count > second.value.count) ? -1 : (first.value.count < second.value.count) ? 1 : 0 )
				 .forEach((sortedData) => countryListSorted[sortedData.key] = (JSON.parse(JSON.stringify(sortedData)
					 .replace('{"key":"'+sortedData.key+'"','')
					 .replace(',"value":','')
					 .slice(0, -1)
				 )));
			 Object.keys(ispList)
	 			 .map(key => ({ key: key, value: ispList[key] }))
	 			 .sort((first, second) => (first.value.count > second.value.count) ? -1 : (first.value.count < second.value.count) ? 1 : 0 )
	 			 .forEach((sortedData) => ispListSorted[sortedData.key] = (JSON.parse(JSON.stringify(sortedData)
	 				 .replace('{"key":"'+sortedData.key+'"','')
	 				 .replace(',"value":','')
	 				 .slice(0, -1)
	 			 )));
		for (i in subversionCount){
			allinfo.count.subversion = allinfo.count.subversion + subversionCount[i]
		}
		for (i in countryCount){
			allinfo.count.country = allinfo.count.country + countryCount[i]
		}
		for (i in ispCount){
			allinfo.count.isp = allinfo.count.isp + ispCount[i]
		}
		for (i in subversionListSorted) {
				let fixed = (subversionListSorted[i].count / allinfo.count.subversion) * 100;
				fixed = fixed.toFixed(2)
				subversionListSorted[i].percent = fixed;
		};
		for (i in countryListSorted) {
				let fixed = (countryListSorted[i].count / allinfo.count.country) * 100;
				fixed = fixed.toFixed(2)
				countryListSorted[i].percent = fixed;
		};
		for (i in ispListSorted) {
				let fixed = (ispListSorted[i].count / allinfo.count.isp) * 100;
				fixed = fixed.toFixed(2)
				ispListSorted[i].percent = fixed;
		};
		let subversionListKeys = [];
		let subversionListValues = [];
		let subversionListPercents = [];
		let countryListKeys = [];
		let countryListValues = [];
		let countryListPercents = [];
		let ispListKeys = [];
		let ispListValues = [];
		let ispListPercents = [];
		for (i in subversionListSorted){
				subversionListKeys.push('"'+i+'"')
				subversionListValues.push(subversionListSorted[i]['count'])
				subversionListPercents.push(subversionListSorted[i]['percent'])
		}
		for (i in countryListSorted){
			countryListKeys.push('"'+i+'"')
			countryListValues.push(countryListSorted[i]['count'])
			countryListPercents.push(countryListSorted[i]['percent'])
		}
		for (i in ispListSorted){
			ispListKeys.push('"'+i+'"')
			ispListValues.push(ispListSorted[i]['count'])
			ispListPercents.push(ispListSorted[i]['percent'])
		}
		allinfo.json = {};
		allinfo.plotly = {};
		allinfo.plotly.subversion = {};
		allinfo.plotly.country = {};
		allinfo.plotly.isp = {};
		allinfo.json.subversion = subversionListSorted;
		allinfo.json.country = countryListSorted;
		allinfo.json.isp = ispListSorted;
		allinfo.plotly.subversion.keys = subversionListKeys;
		allinfo.plotly.country.keys = countryListKeys;
		allinfo.plotly.isp.keys = ispListKeys;
		allinfo.plotly.subversion.values = subversionListValues;
		allinfo.plotly.country.values = countryListValues;
		allinfo.plotly.isp.values = ispListValues;
		allinfo.plotly.subversion.percents = subversionListPercents;
		allinfo.plotly.country.percents = countryListPercents;
		allinfo.plotly.isp.percents = ispListPercents;
		res.set('Content-Type', 'application/json');
		console.log(allinfo.plotly.subversion.keys);
		res.send(allinfo);
	});
});

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
	let css = "<head><script>"+gotoURL+"</script><style>body {  background: #000; } table {  text-align: left;  margin: auto;  /*! border: 3px solid #9d9d9d; */ } table td, table th {  border: 3px solid #9d9d9d;  padding: 5px 2px; } table tbody td {  color: #9D9D9D; } table tr:nth-child(even) {  background: black;  border: 3px solid #9d9d9d; } table tbody tr {  background: #000;  border: 3px solid #5d4343; } table thead tr {  background: #9d9d9d; } table thead th {  font-size: 20px;  font-weight: bold;  color: #000;  text-align: left; } table tfoot {  font-size: 13px;  font-weight: bold;  color: #FFFFFF;  background: #CE3CFF;  background: -moz-linear-gradient(top, #da6dff 0%, #d34fff 66%, #CE3CFF 100%);  background: -webkit-linear-gradient(top, #da6dff 0%, #d34fff 66%, #CE3CFF 100%);  background: linear-gradient(to bottom, #da6dff 0%, #d34fff 66%, #CE3CFF 100%);  border-top: 5px solid #792396; } table tfoot td {  font-size: 13px; } table tfoot .links {  text-align: right; } table tfoot .links a {  display: inline-block;  background: #792396;  color: #FFFFFF;  padding: 2px 8px;  border-radius: 5px; } table tbody tr:hover, table tbody td:hover {  background: #005107; }"+menuCSS+".menu{position:inherit}</style></head>"
	let hostList = Object.values(host2lastconnection);
	hostList = hostList.filter(obj => {return obj.success === true});
	hostList = hostList.map(obj => ({
		host: obj.host + ':' + obj.port,
		version: obj.version,
		height: obj.bestHeight,
		lat: obj.lat,
		long: obj.long,
		location: obj.location,
		provider: obj.isp
	}));
	hostCount = hostList.length;
	hostList = hostList.sort(function(a, b){return b.version - a.version});
		console.log(hostList)
	hostList = tableify(hostList).replace('host','host  ('+hostCount+')');
    res.send(
		  css+
		  menu+
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
		isp: obj.isp,
	}));
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
			"isp: '"+hostList[i].isp+"',"+
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
		"provider: \" + data.isp + \"<br>"+
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
	  "<style>"+menuCSS+"</style>"+
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
                "open(location.origin+'/connections/'+bubbleInfo.host+'.csv');"+
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
	  menu+
	  "<script>"+gotoURL+"</script>"+
	  "</body>";
	res.send(newMap);
	});
});

//Functions
function formatPercentage(val) {
  if (isNaN(val)) val = 0;
  return (val*100).toFixed(2)+"%";
}

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
		let ISP = asnLookup.get(peer.host)
		let city, region, country, regionName, lat, long;
		if (!ISP) ISP = undefined; else ISP = ISP.autonomous_system_organization;
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
		  isp: ISP,
        };
        if (!connectionSaved) {
          connectionSaved = true;
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

function getTime(timestamp){
var date = new Date(timestamp*1000);
date = date.toISOString().match(/(\d{4}\-\d{2}\-\d{2})T(\d{2}:\d{2}:\d{2})/)
date = date[1] + ' ' + date[2]
return date;
}

}

process.on('uncaughtException', (err) => {
  if (!err.toString().startsWith('Error: Unsupported message command')) {
    console.log("unkown err", err);
  }
  console.log("uncaugt ex", err);
});
