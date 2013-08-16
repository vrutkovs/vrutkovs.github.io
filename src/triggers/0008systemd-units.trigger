#!/usr/bin/env python
# Post-installation hook for systemd unit files; -*- mode: python; indent-tabs-mode: nil -*-
#
# Written by Colin Walters <walters@verbum.org>
#
# This library is free software; you can redistribute it and/or
# modify it under the terms of the GNU Lesser General Public
# License as published by the Free Software Foundation; either
# version 2 of the License, or (at your option) any later version.
#
# This library is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# Lesser General Public License for more details.
#
# You should have received a copy of the GNU Lesser General Public
# License along with this library; if not, write to the
# Free Software Foundation, Inc., 59 Temple Place - Suite 330,
# Boston, MA 02111-1307, USA.

import os
import sys
import glob
import subprocess

# These should *really* not be enabled by default; it's an open
# question whether they should have [Install] sections at all.
# The Fedora systemd.spec does:
#        systemctl preset \
#                getty@tty1.service \
#                remote-fs.target \
#                systemd-readahead-replay.service \
#                systemd-readahead-collect.service >/dev/null 2>&1 || :
# But it's fairly lame to have a hardcoded list of units to enable;
# let's instead blacklist broken ones.
systemd_units_to_skip=['debug-shell.service',
                       'console-getty.service',
                       'console-shell.service']

if os.path.exists('/usr/bin/systemctl'):
    # FIXME - need to make user presets work too
    for unittype in ['system']:
        path = '/usr/lib/systemd/' + unittype
        if not os.path.isdir(path):
            continue
        for unitname in glob.glob(path + '/*.service'):
            bn = os.path.basename(unitname)
            if bn in systemd_units_to_skip:
                continue
            if os.path.islink(unitname) or unitname.endswith('@.service'):
                continue
            hasinstall = False
            for line in open(unitname, 'r').readlines():
                if line.startswith('[Install]'):
                    hasinstall = True
                    break
            if not hasinstall:
                continue
            args = ['systemctl', '--' + unittype, 'preset', bn]
            print subprocess.list2cmdline(args)
            subprocess.check_call(args)
