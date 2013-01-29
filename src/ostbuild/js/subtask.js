// Copyright (C) 2012,2013 Colin Walters <walters@verbum.org>
//
// This library is free software; you can redistribute it and/or
// modify it under the terms of the GNU Lesser General Public
// License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.
//
// This library is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Lesser General Public License for more details.
//
// You should have received a copy of the GNU Lesser General Public
// License along with this library; if not, write to the
// Free Software Foundation, Inc., 59 Temple Place - Suite 330,
// Boston, MA 02111-1307, USA.

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const format = imports.format;
const Lang = imports.lang;

const GSystem = imports.gi.GSystem;

const ProcUtil = imports.procutil;

const VERSION_RE = /(\d+)\.(\d+)/;

const TaskHistoryEntry = new Lang.Class({
    Name: 'TaskHistoryEntry',

    _init: function(path, state) {
	this.path = path;
	let match = VERSION_RE.exec(path.get_basename());
	this.major = parseInt(match[1]);
	this.minor = parseInt(match[2]);
	this.versionstr = Format.vprintf('%d.%d', [this.major, this.minor]);
	this.timestamp = null;
	this.logfile_path = null;
	this.start_timestamp = null;

	if (state == undefined) {
	    let statusPath = this.path.get_child('status');
	    if (statusPath.query_exists(null)) {
		let ioStream = statusPath.read(null);
		let info = ioStream.query_info("unix::mtime", null);
		let contents = ioStream.read_bytes(8192, null);
		this.state = contents;
		ioStream.close(null);
		this.timestamp = info.get_attribute_uint64("time::modified");
	    } else {
		this.state = 'interrupted';
	    }
	} else {
	    this.state = state;
	    this.start_timestamp = new Date().getTime() / 1000;
	}
    },

    finish: function(success) {
	let statusPath = this.path.get_child('status');
	this.state = success ? 'success' : 'failed';
	statusPath.replace_contents(this.state, null, false, 0, null);
	this.timestamp = new Date().getTime() / 1000;
    },

    compareTo: function(a, b) {
	function cmp(a, b) {
	    if (a == b) return 0;
	    else if (a < b) return -1;
	    else return 1;
	}
	let c = cmp(a.major, b.major);
	if (c != 0) return c;
	return cmp(a.minor, b.minor);
    }
});

const TaskSet = new Lang.Class({
    Name: 'TaskSet',

    _init: function(path) {
	this.path = path;
	GSystem.file_ensure_directory(this.path, true, null);

	this._history = [];
	this._running = false;
	this._prepared = false;
	this._running_version = null;
	this._maxVersions = 10;
	
	this._load();
    },

    _cleanOldEntries: function() {
	while (this._history.length > this._maxVersions) {
	    let task = this._history.shift();
	    GSystem.shutil_rm_rf(task.path, null);
	}
    },

    _load: function() {
	var e = this.path.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
	let info;
	let history = [];
	while ((info = e.next_file(null)) != null) {
	    let name = info.get_name();
	    let childPath = this.path.get_child(name);
	    let match = VERSION_RE.exec(name);
	    if (!match)
		continue;
	    history.push(new TaskHistoryEntry(childPath))
	}
	history.sort(TaskHistoryEntry.prototype.compareTo);
	this._history = history;
	this._cleanOldEntries();
    },

    _onProcessComplete: function(proc, result) {
	if (!this._running) throw new Error();

	let [success, msg] = ProcUtil.asyncWaitCheckFinish(proc, result);

	let last = this._history[this._history.length-1];
	last.finish(success);
	this._running = false;
	this._process = null;

	this._cleanOldEntries();

	this._processCallback(this, success, msg);
    },

    prepare: function() {
	if (this._running) throw new Error();
	if (this._prepared) throw new Error();
	this._prepared = true;
	let yearver = new Date().getFullYear();
	let lastversion = -1;
	if (this._history.length > 0) {
	    let last = this._history[this._history.length-1];
	    if (last.major == yearver)
		lastversion = last.minor;
	    else
		lastversion = -1;
	}
	let historyPath = this.path.get_child(format.vprintf('%d.%d', [yearver, lastversion + 1]));
	GSystem.file_ensure_directory(historyPath, true, null);

	let entry = new TaskHistoryEntry(historyPath, 'running');
	entry.logfile_path = historyPath.get_child('log');
	this._history.push(entry);
	
	return historyPath;
    },

    start: function(processContext, cancellable, callback) {
	if (this._running) throw new Error();
	if (!this._prepared)
	    this.prepare();
	this._running = true;
	this._prepared = false;
	let last = this._history[this._history.length-1];
	processContext.set_cwd(last.path.get_path());
	processContext.set_stdout_file_path(last.logfile_path.get_path());
	processContext.set_stderr_disposition(GSystem.SubprocessStreamDisposition.STDERR_MERGE);
	this._process = new GSystem.Subprocess({ context: processContext });
	this._processCallback = callback;
	this._process.init(cancellable);
	this._process.wait(cancellable, Lang.bind(this, this._onProcessComplete));
	return last;
    },

    isRunning: function() {
	return this._running;
    },

    getHistory: function() {
	return this._history;
    }
});
