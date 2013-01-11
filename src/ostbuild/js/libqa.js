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
