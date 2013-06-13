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
const Lang = imports.lang;
const Format = imports.format;

const GSystem = imports.gi.GSystem;

const Builtin = imports.builtin;
const Task = imports.task;
const JsonDB = imports.jsondb;
const ProcUtil = imports.procutil;
const JsonUtil = imports.jsonutil;
const Snapshot = imports.snapshot;
const BuildUtil = imports.buildutil;
const Vcs = imports.vcs;
const ArgParse = imports.argparse;

const Make = new Lang.Class({
    Name: 'Make',
    Extends: Builtin.Builtin,

    DESCRIPTION: "Execute tasks",

    _init: function() {
	this.parent();
	this.parser.addArgument(['-n', '--only'], { action: 'storeTrue',
						    help: "Don't process tasks after this" });
	this.parser.addArgument(['-x', '--skip'], { action: 'append',
						    help: "Don't process tasks after this" });
	this.parser.addArgument(['--shell'], { action: 'storeTrue',
					       help: "Start an interactive shell" });
	this.parser.addArgument('taskname');
	this.parser.addArgument('parameters', { nargs: '*' });
    },

    execute: function(args, loop, cancellable) {
	this._initWorkdir(null, cancellable);
	this._loop = loop;
	this._failed = false;
	this._shell = false;
	this._cancellable = cancellable;
	this._shellComplete = false;
	this._tasksComplete = false;
	this._oneOnly = args.only;
	let taskmaster = new Task.TaskMaster(this.workdir.get_child('tasks'),
					     { onEmpty: Lang.bind(this, this._onTasksComplete),
					       processAfter: !args.only,
					       skip: args.skip });
	this._taskmaster = taskmaster;
	taskmaster.connect('task-executing', Lang.bind(this, this._onTaskExecuting));
	taskmaster.connect('task-complete', Lang.bind(this, this._onTaskCompleted));
	let params = this._parseParameters(args.parameters);
	taskmaster.pushTask(args.taskname, params);
	if (args.shell) {
	    this._stdin = new Gio.DataInputStream({ base_stream: GSystem.Console.get_stdin() });
	    this._stdin.read_line_async(GLib.PRIORITY_DEFAULT, cancellable,
					Lang.bind(this, this._onStdinRead));
	    this._shell = true;
	}
	this._console = GSystem.Console.get();
	loop.run();
	if (!this._failed)
	    print("Success!")
    },

    _parseParameters: function(paramStrings) {
	let params = {};
	for (let i = 0; i < paramStrings.length; i++) { 
	    let param = paramStrings[i];
	    let idx = param.indexOf('=');
	    if (idx == -1)
		throw new Error("Invalid key=value syntax");
	    let k = param.substr(0, idx);
	    let v = JSON.parse(param.substr(idx+1));
	    params[k] = v;
	}
	return params;
    },

    _onStdinRead: function(stdin, result) {
	let cancellable = this._cancellable;
	let [line, len] = stdin.read_line_finish_utf8(result);
	let args = line.split(' ');
	if (args.length > 1) {
	    let cmd = args[0];
	    let params = null; 
	    try {
		params = this._parseParameters(args.slice(1));
	    } catch (e) {
		print(e);
	    }
	    if (params !== null) {
		this._taskmaster.pushTask(cmd, params);
	    }
	    this._stdin.read_line_async(GLib.PRIORITY_DEFAULT, cancellable,
					Lang.bind(this, this._onStdinRead));
	} else if (line == "") {
	    this._shellComplete = true;
	    if (this._tasksComplete)
		this._loop.quit();
	}
    },

    _onTaskExecuting: function(taskmaster, task) {
	print("Task " + task.name + " executing in " + task._taskCwd.get_path());
	let output = task._taskCwd.get_child('output.txt');
	if (this._oneOnly) {
	    let context = new GSystem.SubprocessContext({ argv: ['tail', '-f', output.get_path() ] });
	    this._tail = new GSystem.Subprocess({ context: context });
	    this._tail.init(null);
	}
    },

    _onTaskCompleted: function(taskmaster, task, success, error) {
	if (this._oneOnly)
	    this._tail.request_exit();
	if (success) {
	    print("Task " + task.name + " complete: " + task._taskCwd.get_path());
	} else {
	    this._failed = true;
	    print("Task " + task.name + " failed: " + task._taskCwd.get_path());
	}
    },

    _onTasksComplete: function(success, err) {
	if (this._shell && !this._shellComplete)
	    return;
	this._tasksComplete = true;
	if (!success)
	    this._err = err;
	if (!this._shell || this._shellComplete)
	    this._loop.quit();
    }
});
