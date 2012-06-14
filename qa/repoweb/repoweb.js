// -*- indent-tabs-mode: nil -*-

function htmlescape(str) {
    var pre = document.createElement('pre');
    var text = document.createTextNode(str);
    pre.appendChild(text);
    return pre.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");;
}

var repoDataSignal = {};
var repoData = null;

function repoweb_on_data_loaded(data) {
    console.log("data loaded");
    repoData = data;
    $(repoDataSignal).trigger("loaded");
}

function repoweb_init() {
    $.getJSON("data.json", repoweb_on_data_loaded);
}

function repoweb_index_init() {
    repoweb_init();
    $(repoDataSignal).on("loaded", function () {
	$("#repoweb-summary").empty();
	var summary = $("#repoweb-summary").get(0);
	var targets = repoData['targets'];
	for (var name in targets) {
	    var elt;
	    var targetData = targets[name];
	    var div = document.createElement("div");
	    summary.appendChild(div);

	    elt = document.createElement("h3")
	    elt.appendChild(document.createTextNode(name));
	    div.appendChild(elt);
	    elt = document.createTextNode(targetData['revision']);
	    div.appendChild(elt);
	} 
    });
}

function repoweb_files_init() {
    repoweb_init();
    $(repoDataSignal).on("loaded", function () {
	$("#repoweb-files").empty();
	var files = $("#repoweb-files").get(0);
	var targets = repoData['targets'];
	for (var name in targets) {
	    var elt;
	    var targetData = targets[name];
	    var div = document.createElement("div");
	    files.appendChild(div);

	    elt = document.createElement("h3")
	    elt.appendChild(document.createTextNode(name));
	    div.appendChild(elt);
	    elt = document.createElement("pre");
	    elt.appendChild(document.createTextNode(targetData['files']));
	    div.appendChild(elt);
	} 
    });
}
