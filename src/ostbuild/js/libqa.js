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

const GSystem = imports.gi.GSystem;
const Params = imports.params;
const ProcUtil = imports.procutil;
const GuestFish = imports.guestfish;

const DEFAULT_GF_PARTITION_OPTS = ['-m', '/dev/sda3', '-m', '/dev/sda1:/boot'];
const DEFAULT_QEMU_OPTS = ['-vga', 'std', '-m', '768M',
                           '-usb', '-usbdevice', 'tablet',
			   '-smp', '1,sockets=1,cores=1,threads=1'];


function newReadWriteMount(diskpath, cancellable) {
    let mntdir = Gio.File.new_for_path('mnt');
    GSystem.file_ensure_directory(mntdir, true, cancellable);
    let gfmnt = new GuestFish.GuestMount(diskpath, {partitionOpts: DEFAULT_GF_PARTITION_OPTS,
                                                    readWrite: true});
    gfmnt.mount(mntdir, cancellable);
    return [gfmnt, mntdir];
}

function createDiskSnapshot(diskpath, newdiskpath, cancellable) {
    ProcUtil.runSync(['qemu-img', 'create', '-f', 'qcow2', '-o', 'backing_file=' + diskpath.get_path(),
		      newdiskpath.get_path()], cancellable);
}

function getQemuPath() {
    let fallbackPaths = ['/usr/libexec/qemu-kvm']
    let qemuPathString = GLib.find_program_in_path('qemu-kvm');
    qemuPathString = GLib.find_program_in_path('qemu-kvm');
    if (!qemuPathString)
	qemuPathString = GLib.find_program_in_path('kvm');
    if (qemuPathString == null) {
        for (let i = 0; i < fallbackPaths.length; i++) {
            let path = Gio.File.new_for_path(fallbackPaths[i]);
            if (!path.query_exists(null))
                continue;
            qemuPathString = path.get_path();
        }
    }
    if (qemuPathString == null) {
        throw new Error("Unable to find qemu-kvm");
    }
    return qemuPathString;
}

function getDeployDirs(mntdir, osname) {
    let basedir = mntdir.resolve_relative_path('ostree/deploy/' + osname);
    return [basedir.get_child('current'),
	    basedir.get_child('current-etc')];
}

function modifyBootloaderAppendKernelArgs(mntdir, kernelArgs, cancellable) {
    let grubConfPath = mntdir.resolve_relative_path('boot/grub/grub.conf');
    let grubConf = GSystem.file_load_contents_utf8(grubConfPath, cancellable);
    let lines = grubConf.split('\n');
    let modifiedLines = [];
    
    let kernelArg = kernelArgs.join(' ');
    let kernelLineRe = /kernel \//;
    for (let i = 0; i < lines.length; i++) {
	let line = lines[i];
	let match = kernelLineRe.exec(line);
	if (!match)
	    modifiedLines.push(line);
	else
		modifiedLines.push(line + ' ' + kernelArg);
    }
    let modifiedGrubConf = modifiedLines.join('\n');
    grubConfPath.replace_contents(modifiedGrubConf, null, false, Gio.FileCreateFlags.NONE,
				  cancellable);
}

function _findCurrentKernel(mntdir, osname, cancellable) {
    let deployBootdir = mntdir.resolve_relative_path('ostree/deploy/' + osname + '/current/boot');
    let d = deployBootdir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
    let finfo;
    try {
	while ((finfo = d.next_file(cancellable)) != null) {
	    let child = deployBootdir.get_child(finfo.get_name());
	    if (child.get_basename().indexOf('vmlinuz-') == 0) {
                return child;
            }
        }
        throw new Error("Couldn't find vmlinuz- in " + deployBootdir.get_path());
    } finally {
        d.close(null);
    }
};

function _parseKernelRelease(kernelPath) {
    let name = kernelPath.get_basename();
    let idx = name.indexOf('-');
    if (idx == -1) throw new Error("Invalid kernel name " + kernelPath.get_path());
    let kernelRelease = name.substr(idx + 1);
    return kernelRelease;
};

function _getInitramfsPath(mntdir, kernelRelease) {
    let bootdir = mntdir.get_child('boot');
    let initramfsName = 'initramfs-' + kernelRelease + '.img';
    let path = bootdir.resolve_relative_path('ostree/' + initramfsName);
    if (!path.query_exists(null))
        throw new Error("Couldn't find initramfs " + path.get_path());
    return path;
};

function pullDeploy(mntdir, srcrepo, osname, target, cancellable) {
    let bootdir = mntdir.get_child('boot');
    let ostreedir = mntdir.get_child('ostree');
    let ostree_osdir = ostreedir.resolve_relative_path('deploy/' + osname);

    let adminCmd = ['ostree', 'admin', '--ostree-dir=' + ostreedir.get_path(),
                    '--boot-dir=' + mntdir.get_child('boot').get_path()];
    let adminEnv = GLib.get_environ();
    adminEnv.push('LIBGSYSTEM_ENABLE_GUESTFS_FUSE_WORKAROUND=1');
    let procdir = mntdir.get_child('proc');
    if (!procdir.query_exists(cancellable)) {
        ProcUtil.runSync(adminCmd.concat(['init-fs', mntdir.get_path()]), cancellable,
                         {logInitiation: true, env: adminEnv});
    }

    // *** NOTE ***
    // Here we blow away any current deployment.  This is pretty lame, but it
    // avoids us triggering a variety of guestfs/FUSE bugs =(
    // See: https://bugzilla.redhat.com/show_bug.cgi?id=892834
    //
    // But regardless, it's probably useful if every
    // deployment starts clean, and callers can use libguestfs
    // to crack the FS open afterwards and modify config files
    // or the like.
    GSystem.shutil_rm_rf(ostree_osdir, cancellable);

    ProcUtil.runSync(adminCmd.concat(['os-init', osname]), cancellable,
                     {logInitiation: true, env: adminEnv});
    ProcUtil.runSync(['ostree', '--repo=' + ostreedir.get_child('repo').get_path(),
                      'pull-local', srcrepo.get_path(), target], cancellable,
                     {logInitiation: true, env: adminEnv});

    ProcUtil.runSync(adminCmd.concat(['deploy', '--no-kernel', osname, target]), cancellable,
                     {logInitiation: true, env: adminEnv});
    ProcUtil.runSync(adminCmd.concat(['update-kernel', '--no-bootloader', osname]), cancellable,
                     {logInitiation: true, env: adminEnv});
    ProcUtil.runSync(adminCmd.concat(['prune', osname]), cancellable,
                     {logInitiation: true, env: adminEnv});

    let deployKernelPath = this._findCurrentKernel(mntdir, osname, cancellable);
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
timeout=3\n\
title %s\n\
root (hd0,0)\n\
kernel /%s root=LABEL=gnostree-root ostree=%s/current\n\
initrd /%s\n', [osname, bootRelativeKernelPath, osname, bootRelativeInitramfsPath]);
    grubConfPath.replace_contents(grubConf, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
};

function grubInstall(diskpath, cancellable) {
    let gf = new GuestFish.GuestFish(diskpath, {partitionOpts: ['-m', '/dev/sda3', '-m', '/dev/sda1:/boot'],
                                                readWrite: true});
    gf.run('grub-install / /dev/vda\n', cancellable);
}
