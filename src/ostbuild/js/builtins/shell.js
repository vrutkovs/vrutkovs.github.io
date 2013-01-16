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

const Task = imports.task;
const JsonDB = imports.jsondb;
const ProcUtil = imports.procutil;
const JsonUtil = imports.jsonutil;
const Snapshot = imports.snapshot;
const Config = imports.config;
const BuildUtil = imports.buildutil;
const Vcs = imports.vcs;
const ArgParse = imports.argparse;

var loop = GLib.MainLoop.new(null, true);

const Shell = new Lang.Class({
    Name: 'Shell',

    _init: function() {
    },

    execute: function(argv) {
	    imports.console.interact();
    }
});

function main(argv) {
    let ecode = 1;
    var app = new Shell();
    GLib.idle_add(GLib.PRIORITY_DEFAULT,
		  function() { try { app.execute(argv); ecode = 0; } finally { loop.quit(); }; return false; });
    loop.run();
    return ecode;
}
