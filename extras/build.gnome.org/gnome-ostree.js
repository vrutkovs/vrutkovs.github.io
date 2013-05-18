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
var taskData = {};
var taskNames = ['build', 'smoketest', 'integrationtest'];

function _loadTask(taskname) {
    var url = 'work/tasks/' + taskname + '/current/meta.json';
    console.log("loading " + url);
    $.getJSON(url, function(data) {
        console.log("load of " + taskname + " complete");
        taskData[taskname] = data;
        $(repoDataSignal).trigger("taskdata-changed", [taskname]);
    });
}

function repowebInit() {
    for (var i = 0; i < taskNames.length; i++) {
        _loadTask(taskNames[i]);
    }
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

function _renderTask(taskName) {
    var statusNode = $("#" + taskName + "-link").get(0);
    $(statusNode).empty();
    var spanNode = $("#" + taskName + "-span").get(0);
    $(spanNode).empty();
    
    var meta = taskData[taskName];
    var ref = 'work/tasks/' + taskName;
    if (meta.success)
        ref += '/successful';
    else
        ref += '/failed';
    ref += '/' + meta.taskVersion;
    statusNode.setAttribute('href', ref);
    statusNode.setAttribute('rel', 'external');
    var text = meta.taskVersion + ': ' + (meta.success ? "success" : "failed ");
    statusNode.appendChild(document.createTextNode(text));
    if (meta['status'])
        spanNode.appendChild(document.createTextNode('  ' + meta['status']));
}

function repowebIndexInit() {
    repowebInit();
    $(repoDataSignal).on("taskdata-changed", function (event, taskName) {
        _renderTask(taskName);
    });
}
