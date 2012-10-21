// -*- indent-tabs-mode: nil -*-

function htmlescape(str) {
    var pre = document.createElement('pre');
    var text = document.createTextNode(str);
    pre.appendChild(text);
    return pre.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");;
}

function get_page_arg(key) {
    var url = window.location.toString();
    var pos = url.indexOf("?");
    if (pos == -1)
        return null;

    var search = url.substr(pos + 1);
    var params = search.split("&");

    for (var n = 0; n < params.length; n++) {
        var val = params[n].split("=");
        if (val[0] == key)
            return unescape(val[1]);
    }

    return null;
}

var repoDataSignal = {};
var repoData = null;
var prefix = null;

function repoweb_on_data_loaded(data) {
    console.log("data loaded");
    repoData = data;
    prefix = repoData['prefix'];
    $(repoDataSignal).trigger("loaded");
}

function repoweb_init() {
    var id = get_page_arg("prefix");
    if (id == null)
        id = "default";
    var url = "work/autobuilder-" + id + ".json";
    $.getJSON(url, repoweb_on_data_loaded);
}

function timeago(d, now) {
    var diffSeconds = (now.getTime() - d.getTime()) / 1000;
    if (diffSeconds < 0)
        return "(time format error)";
    var units = [["seconds", 60],
                 ["minutes", 60*60],
                 ["hours", 60*60*24],
                 ["days", -1]];
    for (var i = 0; i < units.length; i++) {
        var unitItem = units[i];
        var divisor = i == 0 ? 1 : units[i-1][1];
        if (unitItem[1] == -1 || diffSeconds < unitItem[1]) {
            return "" + (Math.floor(diffSeconds / divisor)) + " " + unitItem[0] + " ago";
        }
    }
}

function renderBuild(container, build) {
    var now = new Date();

    var div = document.createElement('div');
    container.appendChild(div);
    var version = build['meta']['version'];
    var endTimestamp = null;
    if (build['timestamp'])
        endTimestamp = new Date(build['timestamp'] * 1000);
    var a = document.createElement('a');
    div.appendChild(a);
    a.setAttribute('href', 'work/tasks/' + prefix + '-build/' + build['v'] + '/log');
    a.setAttribute('rel', 'external');
    a.appendChild(document.createTextNode("Build " + version));
    div.appendChild(document.createTextNode(": "));
    var stateSpan = document.createElement('span');
    div.appendChild(stateSpan);
    var state = document.createTextNode(build['state']);
    stateSpan.appendChild(state);
    if (build['state'] == 'success')
        $(stateSpan).addClass("repoweb-build-success");
    else
        $(stateSpan).addClass("repoweb-build-failed");
    var status = build['build-status'];
    if (status)
        div.appendChild(document.createTextNode(" " + status['description']));
    else if (endTimestamp)
        div.appendChild(document.createTextNode(" " + timeago(endTimestamp, now)));
}

function repoweb_index_init() {
    repoweb_init();
    $(repoDataSignal).on("loaded", function () {
	$("#resolve-summary").empty();
	var summary = $("#resolve-summary").get(0);

        var div = document.createElement('div');
        summary.appendChild(div);
        div.appendChild(document.createTextNode("Current version: "));
        var a = document.createElement('a');
        div.appendChild(a);
        a.setAttribute('href', 'work/snapshots/' + repoData['version-path']);
        a.setAttribute('rel', 'external');
        a.appendChild(document.createTextNode(repoData['version']));

	$("#build-summary").empty();
	summary = $("#build-summary").get(0);
        var buildData = repoData.build;
        for (var i = buildData.length - 1; i >= 0; i--) {
            var build = buildData[i];
            renderBuild(summary, build);
        }
    });
}
