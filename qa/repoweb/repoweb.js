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

function buildDiffComponentAppend(container, description, a) {
    var additional = 0;
    if (a.length > 10) {
        a = a.slice(0, 10); 
        additional = a.length - 10;
    }
    var p = document.createElement('p');
    container.appendChild(p);
    p.appendChild(document.createTextNode(description + ": " + a.join(", ")));
    if (additional > 0) {
        var b = document.createElement('b');
        p.appendChild(b);
        b.appendChild.document.createTextNode(" and " + additional + " more");
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
    a.setAttribute('href', 'work/tasks/' + prefix + '-build/' + build['v'] + '/log');
    a.setAttribute('rel', 'external');

    var state = build['state'];

    buildDiffAppend(a, build['diff']);
    
    if (state == 'running') {
        var p = document.createElement('p');
        a.appendChild(p);
        var status = build['build-status'];
        if (status)
            text += ": " + status['description'];
        p.appendChild(document.createTextNode(text));
    } else {
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

function updateResolve() {
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
}

function repoweb_index_init() {
    repoweb_init();
    $(repoDataSignal).on("loaded", function () {

	var buildSummary = $("#build-summary").get(0);
        var buildData = repoData.build;
        for (var i = buildData.length - 1; i >= 0; i--) {
            var build = buildData[i];
            renderBuild(buildSummary, build);
        }
        if (buildData.length > 0) {
            var build = buildData[0];
            $("#buildstatus").removeClass("buildstatus-happy");
            $("#buildstatus").removeClass("buildstatus-sad");
            if (build['state'] == 'failed') 
               $("#buildstatus").addClass("buildstatus-sad");
            else
               $("#buildstatus").addClass("buildstatus-happy");
        } else {
               $("#buildstatus").addClass("buildstatus-happy");
        }
	$(buildSummary).listview('refresh');
    });
}
