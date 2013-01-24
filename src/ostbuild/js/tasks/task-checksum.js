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
const Params = imports.params;
const DynTask = imports.dyntask;

const TaskChecksumSha256 = new Lang.Class({
    Name: 'TaskChecksumSha256',
    Extends: DynTask.TaskDef,

    getPattern: function() {
	return [/\/ChecksumSha256\/(.*)$/, 'PATH'];
    },

    _onAsyncOpComplete: function(error) {
	let state = this;
	state.asyncOutstanding--;
	if (state.asyncOutstanding != 0)
	    return;
	if (error) {
	    state.onComplete(null, error);
	} else {
	    let csumStr = state.buf.steal_as_bytes().toArray().toString();
	    state.onComplete(csumStr.substr(0, csumStr.indexOf(' ')), null);
	}
    },

    _onSpliceComplete: function(stream, result) {
	let state = this;

	let error = null;
	try {
	    stream.splice_finish(result);
	} catch (e) {
	    if (e.domain != undefined)
		error = e;
	    else
		throw e;
	}
	Lang.bind(state, state.me._onAsyncOpComplete)(error);
    },

    _onProcWait: function(proc, result) {
	let state = this;

	let error = null;
	try {
	    let [success,ecode] = proc.wait_finish(result);
	    GLib.spawn_check_exit_status(ecode);
	} catch (e) {
	    if (e.domain != undefined)
		error = e;
	    else
		throw e;
	}
	Lang.bind(state, state.me._onAsyncOpComplete)(error);
    },

    execute: function(inputs, dependResults, cancellable, onComplete) {
	let state = {me: this,
		     onComplete: onComplete,
		     buf: null,
		     asyncOutstanding: 2};
	let path = inputs.PATH;
	let context = new GSystem.SubprocessContext({argv: ['sha256sum', path]});
	context.set_stdout_disposition(GSystem.SubprocessStreamDisposition.PIPE);
	let proc = new GSystem.Subprocess({context: context});
	proc.init(cancellable);
	let stdout = proc.get_stdout_pipe();
	state.buf = Gio.MemoryOutputStream.new_resizable();
	state.buf.splice_async(stdout, Gio.OutputStreamSpliceFlags.CLOSE_SOURCE |
			       Gio.OutputStreamSpliceFlags.CLOSE_TARGET, GLib.PRIORITY_DEFAULT,
			       cancellable, Lang.bind(state, this._onSpliceComplete));
	proc.wait(cancellable, Lang.bind(state, this._onProcWait));
    }
});

const TaskChecksumMany = new Lang.Class({
    Name: 'TaskChecksumMany',
    Extends: DynTask.TaskDef,

    getPattern: function() {
	return [/\/ChecksumMany\/(.*)$/, 'FILENAMES'];
    },

    getDepends: function(inputs) {
	let filenamesStr = inputs.FILENAMES;
	let filenames = filenamesStr.split(',');
	let r = [];
	for (let i = 0; i < filenames.length; i++)
	    r.push('/ChecksumSha256/' + filenames[i]);
	return r;
    },

    execute: function(inputs, dependResults, cancellable, onComplete) {
	let r = '';
	for (let i = 0; i < dependResults.length; i++)
	    r += dependResults[i] + '\n';
	GLib.idle_add(GLib.PRIORITY_DEFAULT, function() {
	    onComplete(r, null);
	});
    }
});
