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
const ProcUtil = imports.procutil;
const LibQA = imports.libqa;
const JsonDB = imports.jsondb;
const Config = imports.config;
const JsonUtil = imports.jsonutil;
const GuestFish = imports.guestfish;

const loop = GLib.MainLoop.new(null, true);

const BuildDisks = new Lang.Class({
    Name: 'BuildDisks',
    Extends: Builtin.Builtin,

    DESCRIPTION: "Generate disk images",

    execute: function(args, loop, cancellable) {
        this._initPrefix(null);

	      this.imageDir = this.workdir.get_child('images').get_child(this.prefix);
	      this.currentImageLink = this.imageDir.get_child('current');
	      this.previousImageLink = this.imageDir.get_child('previous');
        GSystem.file_ensure_directory(this.imageDir, true, cancellable);

	      let buildresultDir = this.workdir.get_child('builds').get_child(this.prefix);
	      let builddb = new JsonDB.JsonDB(buildresultDir);

        let latestPath = builddb.getLatestPath();
        let buildVersion = builddb.parseVersionStr(latestPath.get_basename());
        this._buildData = builddb.loadFromPath(latestPath, cancellable);

	      let targets = this._buildData['targets'];

	      // Special case the default target - we do a pull, then clone
	      // that disk for further tests.  This is a speedup under the
	      // assumption that the trees are relatively close, so we avoid
	      // copying data via libguestfs repeatedly.
	      let defaultTarget = this._buildData['snapshot']['default-target'];
        let defaultRevision = this._buildData['targets'][defaultTarget];
	      this._defaultDiskPath = this._diskPathForTarget(defaultTarget, false);

        let tmppath = this._defaultDiskPath.get_parent().get_child(this._defaultDiskPath.get_basename() + '.tmp');
        GSystem.shutil_rm_rf(tmppath, cancellable);

	      if (!this._defaultDiskPath.query_exists(null)) {
            LibQA.createDisk(tmppath, cancellable);
	      } else {
            LibQA.copyDisk(this._defaultDiskPath, tmppath, cancellable);
        }

        let osname = this._buildData['snapshot']['osname'];

	      ProcUtil.runSync(['ostbuild', 'qa-pull-deploy', tmppath.get_path(),
			                    this.repo.get_path(), osname, defaultTarget, defaultRevision],
			                   cancellable, { logInitiation: true });
        
        GSystem.file_rename(tmppath, this._defaultDiskPath, cancellable);

        for (let targetName in targets) {
	          if (targetName == defaultTarget)
		            continue;
            let targetRevision = this._buildData['targets'][targetName];
	          let diskPath = this._diskPathForTarget(targetName, true);
            tmppath = diskPath.get_parent().get_child(diskPath.get_basename() + '.tmp');
            GSystem.shutil_rm_rf(tmppath, cancellable);
	          LibQA.createDiskSnapshot(this._defaultDiskPath, tmppath, cancellable);
	          ProcUtil.runSync(['ostbuild', 'qa-pull-deploy', tmppath.get_path(), 
			                        this.repo.get_path(), osname, targetName, targetRevision],
			                       cancellable, { logInitiation: true });
	      }

        GSystem.file_linkcopy(latestPath, imageDir.get_child(latestPath.get_basename()),
                              Gio.FileCopyFlags.OVERWRITE, cancellable);
    },

    _diskPathForTarget: function(targetName, isSnap) {
	      let squashedName = targetName.replace(/\//g, '_');
	      let suffix;
	      if (isSnap) {
	          suffix = '-snap.qcow2';
	      } else {
	          suffix = '-disk.qcow2';
        }
	      return this.imageDir.get_child(this.prefix + '-' + squashedName + suffix);
    }
});
