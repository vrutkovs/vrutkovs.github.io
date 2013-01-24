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
const Config = imports.config;
const JsonUtil = imports.jsonutil;
const GuestFish = imports.guestfish;

const IMAGE_RETAIN_COUNT = 2;

const TaskBuildDisks = new Lang.Class({
    Name: 'TaskBuildDisks',
    Extends: Task.TaskDef,

    TaskPattern: [/builddisks\/(.*?)$/, 'prefix'],

    TaskAfterPrefix: '/build/',

    // Legacy
    _VERSION_RE: /^(\d+)\.(\d+)$/,

    execute: function(cancellable) {
        let prefix = this.vars['prefix'];

        let subworkdir = Gio.File.new_for_path('.');

	      let baseImageDir = this.workdir.get_child('images').get_child(prefix);
        GSystem.file_ensure_directory(baseImageDir, true, cancellable);
	      let currentImageLink = baseImageDir.get_child('current');
	      let previousImageLink = baseImageDir.get_child('previous');

	      let builddb = this._getResultDb('build/' + prefix);

        let latestPath = builddb.getLatestPath();
        let buildVersion = builddb.parseVersionStr(latestPath.get_basename());
        let buildData = builddb.loadFromPath(latestPath, cancellable);

        let targetImageDir = baseImageDir.get_child(buildVersion);

        if (targetImageDir.query_exists(null)) {
            print("Already created " + targetImageDir.get_path());
            return;
        }

        let workImageDir = subworkdir.get_child('images');
        GSystem.file_ensure_directory(workImageDir, true, cancellable);

	      let targets = buildData['targets'];

        let osname = buildData['snapshot']['osname'];

        for (let targetName in targets) {
            let targetRevision = buildData['targets'][targetName];
	          let squashedName = targetName.replace(/\//g, '_');
	          let diskName = prefix + '-' + squashedName + '-disk.qcow2';
            let diskPath = workImageDir.get_child(diskName);
            let prevPath = currentImageLink.get_child(diskName);
            GSystem.shutil_rm_rf(diskPath, cancellable);
            if (prevPath.query_exists(null)) {
                LibQA.copyDisk(prevPath, diskPath, cancellable);
            } else {
                LibQA.createDisk(diskPath, cancellable);
            }
	          ProcUtil.runSync(['ostbuild', 'qa-pull-deploy', diskPath.get_path(), 
			                        this.repo.get_path(), osname, targetName, targetRevision],
			                       cancellable, { logInitiation: true });
	      }

        GSystem.file_rename(workImageDir, targetImageDir, cancellable);

        let currentInfo = null;
        try {
            currentInfo = currentImageLink.query_info('standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw e;
        }
        if (currentInfo != null) {
            let newPreviousTmppath = baseImageDir.get_child('previous-new.tmp');
            let currentLinkTarget = currentInfo.get_symlink_target();
            GSystem.shutil_rm_rf(newPreviousTmppath, cancellable);
            newPreviousTmppath.make_symbolic_link(currentLinkTarget, cancellable);
            GSystem.file_rename(newPreviousTmppath, previousImageLink, cancellable);
        }
        BuildUtil.atomicSymlinkSwap(baseImageDir.get_child('current'), targetImageDir, cancellable);

        this._cleanOldVersions(baseImageDir, IMAGE_RETAIN_COUNT, cancellable);
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
