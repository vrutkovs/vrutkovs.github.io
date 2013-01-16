// Copyright (C) 2011 Colin Walters <walters@verbum.org>
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

const Format = imports.format;

const BUILTINS = {'autobuilder': "Run resolve and build",
                  'checkout': "Check out source tree",
                  'prefix': "Display or modify \"prefix\" (build target)",
                  'git-mirror': "Update internal git mirror for one or more components",
                  'resolve': "Expand git revisions in source to exact targets",
                  'build': "Build multiple components and generate trees",
                  'shell': "Interactive JavaScript shell",
                  'qa-make-disk': "Generate a bare disk image",
		  'qa-pull-deploy': "Copy OSTree repo into virtual disk and deploy it",
		  'qa-smoketest': "Basic smoke testing via parsing serial console"};

function usage(ecode) {
    print("Builtins:");
    for (let builtin in BUILTINS) {
	let description = BUILTINS[builtin];
        print(Format.vprintf("    %s - %s", [builtin, description]));
    }
    return ecode;
}

if (ARGV.length < 1) {
    usage(1);
} else if (ARGV[0] == '-h' || ARGV[0] == '--help') {
    usage(0);
} else {
    let name = ARGV[0];
    if (!BUILTINS[name]) {
	usage(1);
    }
    let args = ARGV.concat();
    args.shift();
    imports.builtins[name.replace(/-/g, '_')].main(args);
}
    
    
