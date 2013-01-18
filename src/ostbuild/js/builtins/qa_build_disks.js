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

const ArgParse = imports.argparse;
const ProcUtil = imports.procutil;
const LibQA = imports.libqa;
const Config = imports.config;
const JsonUtil = imports.jsonutil;
const GuestFish = imports.guestfish;

const loop = GLib.MainLoop.new(null, true);

const QaBuildDisks = new Lang.Class({
    Name: 'QaBuildDisks',

    execute: function(argv) {
	      let cancellable = null;
	      this.config = Config.get();
	      this.workdir = Gio.File.new_for_path(this.config.getGlobal('workdir'));
	      this.prefix = this.config.getPrefix();
	      this.repo = this.workdir.get_child('repo');
	      this._snapshot_dir = this.workdir.get_child('snapshots');
	      this._buildDataPath = this.workdir.get_child(this.prefix + '-buildresult.json');
	      this._buildData = JsonUtil.loadJson(this._buildDataPath, cancellable);

	      let targets = this._buildData['targets'];

	      // Special case the default target - we do a pull, then clone
	      // that disk for further tests.  This is a speedup under the
	      // assumption that the trees are relatively close, so we avoid
	      // copying data via libguestfs repeatedly.
	      let defaultTarget = this._buildData['snapshot']['default-target'];
	      this._defaultDiskPath = this._diskPathForTarget(defaultTarget, false);

	      if (!this._defaultDiskPath.query_exists(null)) {
	          ProcUtil.runSync(['ostbuild', 'qa-make-disk', this._defaultDiskPath.get_path()],
                             cancellable);
	      }

        let osname = this._buildData['snapshot']['osname'];

	      ProcUtil.runSync(['ostbuild', 'qa-pull-deploy', this._defaultDiskPath.get_path(),
			                    this.repo.get_path(), osname, defaultTarget],
			                   cancellable, { logInitiation: true });

        for (let targetName in targets) {
	          if (targetName == defaultTarget)
		            continue;
	          let diskPath = this._diskPathForTarget(targetName, true);
            GSystem.shutil_rm_rf(diskPath, cancellable);
	          LibQA.createDiskSnapshot(this._defaultDiskPath, diskPath, cancellable);
	          ProcUtil.runSync(['ostbuild', 'qa-pull-deploy', diskPath.get_path(), 
			                        this.repo.get_path(), osname, targetName],
			                       cancellable, { logInitiation: true });
	      }
    },

    _diskPathForTarget: function(targetName, isSnap) {
	      let squashedName = targetName.replace(/\//g, '_');
	      let suffix;
	      if (isSnap) {
	          suffix = '-snap.qcow2';
	      } else {
	          suffix = '-disk.qcow2';
        }
	      return this.workdir.get_child(this.prefix + '-' + squashedName + suffix);
    }
});

function main(argv) {
    let ecode = 1;
    var app = new QaBuildDisks();
    GLib.idle_add(GLib.PRIORITY_DEFAULT,
                  function() { try { app.execute(argv); ecode = 0; } finally { loop.quit(); }; return false; });
    loop.run();
    return ecode;
}
