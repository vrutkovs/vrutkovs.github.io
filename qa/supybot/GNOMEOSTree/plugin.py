###
# Copyright (c) 2003-2004, Jeremiah Fincher
# Copyright (c) 2012 Colin Walters <walters@verbum.org>
# All rights reserved.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are met:
#
#   * Redistributions of source code must retain the above copyright notice,
#     this list of conditions, and the following disclaimer.
#   * Redistributions in binary form must reproduce the above copyright notice,
#     this list of conditions, and the following disclaimer in the
#     documentation and/or other materials provided with the distribution.
#   * Neither the name of the author of this software nor the name of
#     contributors to this software may be used to endorse or promote products
#     derived from this software without specific prior written consent.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
# AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
# IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
# ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
# LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
# CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
# SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
# INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
# CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
# ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
# POSSIBILITY OF SUCH DAMAGE.
###

import time
import os
import re
import shutil
import tempfile
import json

import supybot.ircdb as ircdb
import supybot.ircmsgs as ircmsgs
import supybot.ircutils as ircutils
import supybot.conf as conf
import supybot.utils as utils
from supybot.commands import *
import supybot.schedule as schedule
import supybot.callbacks as callbacks
import supybot.world as world

class GNOMEOSTree(callbacks.Plugin):
    def __init__(self, irc):
        self.__parent = super(GNOMEOSTree, self)
        self.__parent.__init__(irc)
        schedule.addPeriodicEvent(self._query_new_build, 1, now=False)
        self._irc = irc
        self._last_build_version = None
        self._last_smoketest_version = None
        self._jsondb_re = re.compile(r'^(\d+\.\d+)-([0-9a-f]+)\.json$')
        self._workdir = os.path.expanduser('~/ostbuild/work/')
        self._workurl = "http://ostree.gnome.org/work/"

    def _broadcast(self, msg):
        for channel in self._irc.state.channels:
            self._irc.queueMsg(ircmsgs.privmsg(channel, msg))

    def _query_new_build(self, status=False):
        current_build_path = os.path.join(self._workdir, 'tasks/build/current')
        meta_path = os.path.join(current_build_path, 'meta.json')
        if not os.path.exists(meta_path):
            return
        f = open(meta_path)
        build_meta = json.load(f)
        f.close()

        version = None
        for name in os.listdir(current_build_path):
            match = self._jsondb_re.search(name)
            if match is None:
                continue
            version = match.group(1)
            break
        if version is None:
            print("No source snapshot found in build directory")
            return

        version_unchanged = version == self._last_build_version
        if (not status and version_unchanged):
            return

        self._last_build_version = version
        if (not status and not version_unchanged):
            msg = "New build"
        else:
            msg = "Current build"
        success = build_meta['success']
        success_str = success and 'successful' or 'failed'
        msg += " %s: %s. " % (version, success_str)
        msg += self._workurl + "tasks/build/%s/%s/output.txt" % (success_str, build_meta['taskVersion'])

        if not success:
            msg = ircutils.mircColor(msg, fg='red')
        else:
            msg = ircutils.mircColor(msg, fg='green')

        self._broadcast(msg)

    def _query_new_smoketest(self, status=False):
        current_smoketest_path = os.path.join(self._workdir, 'tasks/smoketest/current')
        meta_path = os.path.join(current_build_path, 'meta.json')
        if not os.path.exists(meta_path):
            return

        f = open(meta_path)
        smoketest_meta = json.load(f)
        f.close()
        
        taskver = smoketest_meta['taskVersion']

        version_unchanged = taskver == self._last_smoketest_version
        if version_unchanged:
            return

        self._last_smoketest_version = version
        msg = "New smoketest"
        success = smoketest_meta['success']
        success_str = success and 'successful' or 'failed'
        msg += " %s: %s. " % (version, success_str)
        msg += self._workurl + "tasks/smoketest/%s/%s/output.txt" % (success_str, taskver)

        if not success:
            msg = ircutils.mircColor(msg, fg='red')
        else:
            msg = ircutils.mircColor(msg, fg='green')

        self._broadcast(msg)

    def buildstatus(self, irc, msg, args):
        self._query_new_build(status=True)

Class = GNOMEOSTree
