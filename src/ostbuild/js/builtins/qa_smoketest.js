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

const QaSmokeTest = new Lang.Class({
    Name: 'QaSmokeTest',

    execute: function(argv) {
        let cancellable = null;
        let parser = new ArgParse.ArgumentParser("Basic smoke testing via parsing serial console");
        parser.addArgument('diskpath');
        
        let args = parser.parse(argv);

        let diskpath = Gio.File.new_for_path(args.diskpath);

        let workdir = Gio.File.new_for_path('.');

        let fallbackPaths = ['/usr/libexec/qemu-kvm']
        let qemuPathString = GLib.find_program_in_path('qemu-kvm');
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

        let qemuArgs = [qemuPathString, '-vga', 'std', 'm', '768M',
                        '-usb', '-usbdevice', 'tablet',
                        '-drive', 'file=' + diskpath + ',if=virtio',
                       ];

        let qemuContext = new GSystem.SubprocessContext({ argv: qemuArgs });
        let qemu = new GSystem.Subprocess({context: qemuContext});
        print("starting qemu");
        qemu.init(cancellable);

        qemu.wait_sync_check(cancellable);
        
        print("Complete!");
    }
});

function main(argv) {
    let ecode = 1;
    var app = new QaSmokeTest();
    GLib.idle_add(GLib.PRIORITY_DEFAULT,
                  function() { try { app.execute(argv); ecode = 0; } finally { loop.quit(); }; return false; });
    loop.run();
    return ecode;
}
