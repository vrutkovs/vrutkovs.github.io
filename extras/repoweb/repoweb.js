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
var currentBuildMeta = null;
var currentSmoketestMeta = null;

function repowebInit() {
    var url;
    url = "work/tasks/build/current/meta.json";
    $.getJSON(url, function(data) {
        currentBuildMeta = data;
        $(repoDataSignal).trigger("current-build-meta-loaded");
    });
    url = "work/tasks/smoketest/current/meta.json";
    $.getJSON(url, function(data) {
        currentSmoketestMeta = data;
        $(repoDataSignal).trigger("current-smoketest-meta-loaded");
    });
}

function timeago(d, now) {
    var diffSeconds = (now.getTime() - d.getTime()) / 1000;
    if (diffSeconds < 0)
        return "a moment ago";
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

function buildDiffAppend(container, buildDiff) {
    if (!buildDiff)
        return document.createTextNode("No changes or new build");
    var added = buildDiff[0];
    var modified = buildDiff[1];
    var removed = buildDiff[2];

    if (added.length > 0)
        buildDiffComponentAppend(container, 'Added', added);
    if (modified.length > 0)
        buildDiffComponentAppend(container, 'Updated', modified);
    if (removed.length > 0)
        buildDiffComponentAppend(container, 'removed', removed);
}

function renderBuild(container, build) {
    var now = new Date();

    var version = build['meta']['version'];

    var divider = document.createElement('li');
    container.appendChild(divider);
    divider.setAttribute('data-role', 'list-divider');
    divider.setAttribute('role', 'heading');
    divider.appendChild(document.createTextNode(version));
    if (build['timestamp']) {
        var endTimestamp = new Date(build['timestamp'] * 1000);
        var span = document.createElement('span');
        divider.appendChild(span);
        $(span).addClass("time");
        span.appendChild(document.createTextNode(timeago(endTimestamp, now)));
    }

    var li = document.createElement('li');
    li.setAttribute('data-theme', '');
    container.appendChild(li);
    var a = document.createElement('a');
    li.appendChild(a);
    a.setAttribute('href', 'work/tasks/build/' + build['v'] + '/log');
    a.setAttribute('rel', 'external');

    var state = build['state'];

    if (state == 'running') {
      a.appendChild(document.createTextNode("Running: "));
    }

    buildDiffAppend(a, build['diff']);
    
    if (state != 'running') {
        var p = document.createElement('span');
        a.appendChild(p);
        var stateSpan = document.createElement('span');
        p.appendChild(stateSpan);
        if (state == 'success')
            li.setAttribute('data-icon', 'check');
        else if (state == 'failed')
            li.setAttribute('data-icon', 'alert');
    }

}

function repowebIndexInit() {
    repowebInit();
    $(repoDataSignal).on("current-build-meta-loaded", function () {
	var buildMetaNode = $("#build-meta").get(0);

        $(buildMetaNode).empty();
        var ref = 'work/tasks/build/';
        if (currentBuildMeta.success)
            ref += '/successful';
        else
            ref += '/failed';
        ref += '/' + currentBuildMeta.taskVersion;
        var a = document.createElement('a');
        a.setAttribute('href', ref);
        a.setAttribute('rel', 'external');
        a.appendChild(document.createTextNode(currentBuildMeta.taskVersion));
        buildMetaNode.appendChild(a);
        buildMetaNode.appendChild(document.createTextNode(': ' + (currentBuildMeta.success ? "success" : "failed ")));
        
        $("#build-icon").removeClass("buildstatus-happy");
        $("#build-icon").removeClass("buildstatus-sad");
        if (currentBuildMeta.success) {
            $("#build-icon").addClass("buildstatus-happy");
        } else {
            $("#build-icon").addClass("buildstatus-sad");
        }
    });
    $(repoDataSignal).on("current-smoketest-meta-loaded", function () {
	var node = $("#smoketest-meta").get(0);

        $(node).empty();
        var ref = 'work/tasks/smoketest/';
        if (currentSmoketestMeta.success)
            ref += '/successful';
        else
            ref += '/failed';
        ref += '/' + currentSmoketestMeta.taskVersion;
        var a = document.createElement('a');
        a.setAttribute('href', ref);
        a.setAttribute('rel', 'external');
        a.appendChild(document.createTextNode(currentSmoketestMeta.taskVersion));
        node.appendChild(a);
        node.appendChild(document.createTextNode(': ' + (currentSmoketestMeta.success ? "success" : "failed ")));
    });
}
