// Copyright (C) 2012 Colin Walters <walters@verbum.org>
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

const ProcUtil = imports.procutil;

var loop = GLib.MainLoop.new(null, true);

const QemuPullDeploy = new Lang.Class({
    Name: 'QemuPullDeploy',
    
    _umount: function(cancellable) {
	let proc = GSystem.Subprocess.new_simple_argv(['umount', self.mountpoint],
						      GSystem.SubprocessStreamDisposition.NULL,
						      GSystem.SubprocessStreamDisposition.NULL);
	proc.wait_sync(cancellable);
    },

    _createQemuDisk: function(cancellable) {
        let success = false;
        let tmpPath = this.qemuPath.get_parent().get_child(this.qemuPath.get_basename() + '.tmp');
	GSystem.shutil_rm_rf(tmpPath, cancellable);
        ProcUtil.runSync(['qemu-img', 'create', tmpPath.get_path(), '6G'], cancellable,
			 {cwd: this.ostreeDir});
        ProcUtil.runSync(['mkfs.ext4', '-q', '-F', tmpPath.get_path()], cancellable,
			 {cwd: this.ostreeDir});

	this._umount();
	try {
            ProcUtil.runSync(['mount', '-o', 'loop', tmpPath.get_path(), this.mountpoint], cancellable);
	    ProcUtil.runSync(['ostree', 'admin', 'init-fs', this.mountpoint.get_path()], cancellable);
            success = true;
	} finally {
	    this._umount();
	}
        if (success) {
            GSystem.file_rename(tmpPath, this.qemuPath, cancellable);
	}
    },
    
    execute: function(argv) {
	let cancellable = null;
        let parser = new ArgParse.ArgumentParser("Copy from local repository into qemu disk and deploy");
        parser.addArgument('--rootdir', {help:"Directory containing OSTree data (default: /ostree)"});
        parser.addArgument('srcrepo');
        parser.addArgument('target');

        let args = parser.parse(argv);

        if (args.rootdir) {
            this.ostreeDir = Gio.File.new_for_path(args.rootdir);
        } else {
            this.ostreeDir = Gio.File.new_for_path('/ostree');
	}

        this.qemuPath = this.ostreeDir.get_child('ostree-qemu.img');
        this.mountpoint = this.ostreeDir.get_child('ostree-qemu-mnt');
        GSystem.file_ensure_directory(this.mountpoint);

        if (!this.qemuPath.query_exists(cancellable)) {
            this._createQemuDisk(cancellable);
	}
    
        this._umount();
        let ostreeDir = this.mountpoint.get_child('ostree');
        let repoPath = ostreeDir.get_child('repo');
        try {
            ProcUtil.runSync(['mount', '-o', 'loop', this.qemuPath.get_path(), this.mountpoint], cancellable);
	    ProcUtil.runSync(['ostree', '--repo=' + repoPath.get_path(), 'pull-local', args.srcrepo, args.target], cancellable);
            ProcUtil.runSync(['ostree', 'admin', '--ostree-dir=' + ostreeDir.get_path(), 'deploy', '--no-kernel', args.target], cancellable,
			     {cwd:ostreeDir});
        } finally {
	    this._umount();
	}
    }
});

var app = new QemuPullDeploy();
GLib.idle_add(GLib.PRIORITY_DEFAULT,
	      function() { try { app.execute(ARGV); } finally { loop.quit(); }; return false; });
loop.run();
