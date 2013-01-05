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

const loop = GLib.MainLoop.new(null, true);

const QaPullDeploy = new Lang.Class({
    Name: 'QaPullDeploy',

    _findCurrentKernel: function(mntdir, osname, cancellable) {
        let deployBootdir = mntdir.resolve_relative_path('ostree/deploy/' + osname + '/current/boot');
        let d = deployBootdir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
	      let finfo;
	      while ((finfo = d.next_file(cancellable)) != null) {
	          let child = deployBootdir.get_child(finfo.get_name());
	          if (child.get_basename().indexOf('vmlinuz-') == 0) {
                return child;
            }
        }
        d.close(cancellable);
        throw new Error("Couldn't find vmlinuz- in " + deployBootdir.get_path());
    },

    _parseKernelRelease: function(kernelPath) {
        let name = kernelPath.get_basename();
        let idx = name.indexOf('-');
        if (idx == -1) throw new Error("Invalid kernel name " + kernelPath.get_path());
        let kernelRelease = name.substr(idx + 1);
        return kernelRelease;
    },

    _getInitramfsPath: function(mntdir, kernelRelease) {
        let bootdir = mntdir.get_child('boot');
        let initramfsName = 'initramfs-' + kernelRelease + '.img';
        let path = bootdir.resolve_relative_path('ostree/' + initramfsName);
        if (!path.query_exists(null))
            throw new Error("Couldn't find initramfs " + path.get_path());
        return path;
    },

    // https://bugzilla.redhat.com/show_bug.cgi?id=892834
    // Also; we have to recreate it as a directory, then
    // delete that again to avoid further fuse/guestfs bugs.
    _workaroundGuestfsFuseBug: function(symlinkPath, cancellable) {
        GSystem.shutil_rm_rf(symlinkPath, cancellable);
        GSystem.file_ensure_directory(symlinkPath, true, cancellable);
        let dummyFile = symlinkPath.get_child('dummy');
        dummyFile.replace_contents('hello world', null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
        GSystem.shutil_rm_rf(symlinkPath, cancellable);
    },

    execute: function(argv) {
        let cancellable = null;
        let parser = new ArgParse.ArgumentParser("Generate a disk image");
        parser.addArgument('diskpath');
        parser.addArgument('srcrepo');
        parser.addArgument('osname');
        parser.addArgument('target');
        
        let args = parser.parse(argv);

        let diskpath = Gio.File.new_for_path(args.diskpath);

        let workdir = Gio.File.new_for_path('.');
        let mntdir = workdir.get_child('mnt');
        GSystem.file_ensure_directory(mntdir, true, cancellable);
        let bootdir = mntdir.get_child('boot');
        let ostreedir = mntdir.get_child('ostree');
        let ostree_osdir = ostreedir.resolve_relative_path('deploy/' + args.osname);
        let guestmountPidFile = workdir.get_child('guestmount.pid');

        if (guestmountPidFile.query_exists(null)) {
            throw new Error("guestmount pid file exists (unclean shutdown?): " + guestmountPidFile.get_path());
        }

        try {
            let procContext = new GSystem.SubprocessContext({ argv: ['guestmount', '--rw', '-o', 'allow_root',
                                                                     '--pid-file', guestmountPidFile.get_path(),
                                                                     '-a', diskpath.get_path(),
                                                                     '-m', '/dev/sda3',
                                                                     '-m', '/dev/sda1:/boot',
                                                                     mntdir.get_path()] });
            let guestfishProc = new GSystem.Subprocess({context: procContext});
            print("starting guestfish");
            guestfishProc.init(cancellable);
            guestfishProc.wait_sync_check(cancellable);
            // guestfish should have daemonized now (unfortunately, if
            // there was a way to avoid that we would).

            let adminCmd = ['ostree', 'admin', '--ostree-dir=' + ostreedir.get_path(),
                            '--boot-dir=' + mntdir.get_child('boot').get_path()];
            let adminEnv = GLib.get_environ();
            adminEnv.push('LIBGSYSTEM_ENABLE_GUESTFS_FUSE_WORKAROUND=1');
            let procdir = mntdir.get_child('proc');
            if (!procdir.query_exists(cancellable)) {
                ProcUtil.runSync(adminCmd.concat(['init-fs', mntdir.get_path()]), cancellable,
                                 {logInitiation: true, env: adminEnv});
            }
            ProcUtil.runSync(adminCmd.concat(['os-init', args.osname]), cancellable,
                             {logInitiation: true, env: adminEnv});
            ProcUtil.runSync(adminCmd.concat(['os-init', args.osname]), cancellable,
                             {logInitiation: true, env: adminEnv});
            ProcUtil.runSync(['ostree', '--repo=' + ostreedir.get_child('repo').get_path(),
                              'pull-local', args.srcrepo, args.target], cancellable,
                             {logInitiation: true, env: adminEnv});

            let currentDeployLink = ostree_osdir.get_child('current');
            let currentEtcDeployLink = ostree_osdir.get_child('current-etc');
            this._workaroundGuestfsFuseBug(currentDeployLink, cancellable);
            this._workaroundGuestfsFuseBug(currentEtcDeployLink, cancellable);
            
            ProcUtil.runSync(adminCmd.concat(['deploy', '--no-kernel', args.osname, args.target]), cancellable,
                             {logInitiation: true, env: adminEnv});
            ProcUtil.runSync(adminCmd.concat(['update-kernel', '--no-bootloader', args.osname]), cancellable,
                             {logInitiation: true, env: adminEnv});
            ProcUtil.runSync(adminCmd.concat(['prune', args.osname]), cancellable,
                             {logInitiation: true, env: adminEnv});

            let deployKernelPath = this._findCurrentKernel(mntdir, args.osname, cancellable);
            let bootKernelPath = bootdir.resolve_relative_path('ostree/' + deployKernelPath.get_basename());
            if (!bootKernelPath.query_exists(cancellable))
                throw new Error("" + bootKernelPath.get_path() + " doesn't exist");
            let kernelRelease = this._parseKernelRelease(deployKernelPath);
            let initramfsPath = this._getInitramfsPath(mntdir, kernelRelease);

            let defaultFstab = 'LABEL=gnostree-root / ext4 defaults 1 1\n\
LABEL=gnostree-boot /boot ext4 defaults 1 2\n\
LABEL=gnostree-swap swap swap defaults 0 0\n';
            let fstabPath = ostreedir.resolve_relative_path('deploy/gnome-ostree/current-etc/fstab'); 
            fstabPath.replace_contents(defaultFstab, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
            
            let grubDir = mntdir.resolve_relative_path('boot/grub');
            GSystem.file_ensure_directory(grubDir, false, cancellable);
            let bootRelativeKernelPath = bootdir.get_relative_path(bootKernelPath);
            if (bootRelativeKernelPath == null)
                throw new Error("" + bootKernelPath.get_path() + " is not relative to " + bootdir.get_path());
            let bootRelativeInitramfsPath = bootdir.get_relative_path(initramfsPath);
            let grubConfPath = grubDir.get_child('grub.conf');
            let grubConf = Format.vprintf('default=0\n\
timeout=5\n\
title GNOME-OSTree\n\
        root (hd0,0)\n\
        kernel /%s root=LABEL=gnostree-root\n\
        initrd /%s\n', [bootRelativeKernelPath, bootRelativeInitramfsPath]);
            grubConfPath.replace_contents(grubConf, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
        } finally {
            if (guestmountPidFile.query_exists(null)) {
                let pidStr = GSystem.file_load_contents_utf8(guestmountPidFile, cancellable);
                if (pidStr.length > 0) {
                    for (let i = 0; i < 30; i++) {
                        // See "man guestmount" for why retry loops here might be needed if this
                        // script is running on a client machine with programs that watch for new mounts
                        try {
                            ProcUtil.runSync(['fusermount', '-u', mntdir.get_path()], cancellable,
                                             {logInitiation: true});
                            break;
                        } catch (e) {
                            if (!(e.origError && e.origError.domain == GLib.spawn_exit_error_quark()))
                                throw e;
                            else
                                GLib.usleep(GLib.USEC_PER_SEC);
                        }
                    }
                    let pid = parseInt(pidStr);
                    for (let i = 0; i < 30; i++) {
                        let killContext = new GSystem.SubprocessContext({argv: ['kill', '-0', ''+pid]});
                        killContext.set_stderr_disposition(GSystem.SubprocessStreamDisposition.NULL);
                        let killProc = new GSystem.Subprocess({context: killContext});
                        killProc.init(null);
                        let [waitSuccess, ecode] = killProc.wait_sync(null);
                        let [killSuccess, statusStr] = ProcUtil.getExitStatusAndString(ecode);
                        if (killSuccess) {
                            print("Awaiting termination of guestfish, pid=" + pid + " timeout=" + (30 - i) + "s");
                            GLib.usleep(GLib.USEC_PER_SEC);
                        } else {
                            break;
                            print("guestmount exited");
                        }
                    }
                }
            }
        }

        let grubInstallCmds = 'grub-install / /dev/vda\n';
        let lines = ProcUtil.runProcWithInputSyncGetLines(['guestfish', '-a', args.diskpath,
                                                           '-m', '/dev/sda3',
                                                           '-m', '/dev/sda1:/boot'],
                                                          cancellable, grubInstallCmds);
        
        print("Complete!");
    }
});

function main(argv) {
    let ecode = 1;
    var app = new QaPullDeploy();
    GLib.idle_add(GLib.PRIORITY_DEFAULT,
                  function() { try { app.execute(argv); ecode = 0; } finally { loop.quit(); }; return false; });
    loop.run();
    return ecode;
}
