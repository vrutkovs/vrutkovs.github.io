// -*- indent-tabs-mode: nil; tab-width: 2; -*-
// Copyright (C) 2013 Colin Walters <walters@verbum.org>
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
const ArgParse = imports.argparse;
const Task = imports.task;
const ProcUtil = imports.procutil;
const BuildUtil = imports.buildutil;
const LibQA = imports.libqa;
const JsonDB = imports.jsondb;
const JsonUtil = imports.jsonutil;
const JSUtil = imports.jsutil;
const GuestFish = imports.guestfish;

const TaskZDisks = new Lang.Class({
    Name: 'TaskZDisks',
    Extends: Task.TaskDef,

    TaskName: "zdisks",
    TaskAfter: ['builddisks'],

    // Legacy
    _VERSION_RE: /^(\d+)\.(\d+)$/,

    execute: function(cancellable) {
        let subworkdir = Gio.File.new_for_path('.');

	      let baseImageDir = this.workdir.resolve_relative_path('images/z');
        GSystem.file_ensure_directory(baseImageDir, true, cancellable);
	      let currentImageLink = baseImageDir.get_child('current');

	      let sourceImageDir = this.workdir.get_child('images');
        let sourceCurrent = sourceImageDir.get_child('current');
        let sourceRevision = sourceCurrent.query_info('standard::symlink-target',
                                                      Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                                                      cancellable).get_symlink_target();
        let targetImageDir = baseImageDir.get_child(sourceRevision);
        if (targetImageDir.query_exists(null)) {
            print("Already created " + targetImageDir.get_path());
            return;
        }

        let workImageDir = subworkdir.get_child('images');
        GSystem.file_ensure_directory(workImageDir, true, cancellable);

        let e = sourceCurrent.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                                                 cancellable);
        let info;
	      while ((info = e.next_file(cancellable)) != null) {
	          let name = info.get_name();
            if (!JSUtil.stringEndswith(name, '.qcow2'))
                continue;
            let inPath = e.get_child(info);
            let outPath = workImageDir.get_child(name + '.gz');
            let outStream = outPath.create(Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
            let compressor = Gio.ZlibCompressor.new(Gio.ZlibCompressorFormat.GZIP, 7);
            let outConverter = Gio.ConverterOutputStream.new(outStream, compressor);
            let inStream = inPath.read(cancellable);
            outConverter.splice(inStream, Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | 
                                Gio.OutputStreamSpliceFlags.CLOSE_TARGET, cancellable);
        }

        GSystem.file_rename(workImageDir, targetImageDir, cancellable);

        BuildUtil.atomicSymlinkSwap(currentImageLink, targetImageDir, cancellable);

        this._cleanOldVersions(baseImageDir, 1, cancellable);
    },

    _loadVersionsFrom: function(dir, cancellable) {
	      let e = dir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
	      let info;
	      let results = [];
	      while ((info = e.next_file(cancellable)) != null) {
	          let name = info.get_name();
	          let match = this._VERSION_RE.exec(name);
	          if (!match)
		            continue;
	          results.push(name);
	      }
	      results.sort(BuildUtil.compareVersions);
	      return results;
    },

    _cleanOldVersions: function(dir, retain, cancellable) {
	      let versions = this._loadVersionsFrom(dir, cancellable);
	      while (versions.length > retain) {
	          let child = dir.get_child(versions.shift());
	          GSystem.shutil_rm_rf(child, cancellable);
	      }
    },

});
