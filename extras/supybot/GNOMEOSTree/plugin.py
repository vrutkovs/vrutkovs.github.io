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

import os
import json

import supybot.ircmsgs as ircmsgs
import supybot.ircutils as ircutils
import supybot.schedule as schedule
import supybot.callbacks as callbacks

class GNOMEOSTree(callbacks.Plugin):
    def __init__(self, irc):
        super(GNOMEOSTree, self).__init__(irc)
        schedule.addPeriodicEvent(self._query_new_tasks, 1, now=False)
        self._irc = irc
        self._flood_channels = ['#testable']
        self._status_channels = ['#gnome-hackers']
        self._last_task_state = {}
        tracked_build = 'buildmaster'
        self._workdir = os.path.expanduser('/srv/ostree/ostbuild/%s/' % (tracked_build, ))
        self._workurl = "http://build.gnome.org/ostree/%s/" % (tracked_build, )

    def _sendTo(self, channels, msg):
        for channel in channels:
            self._irc.queueMsg(ircmsgs.privmsg(channel, msg))

    def _query_new_tasks(self, status=False):
        for taskname in ['build', 'smoketest', 'integrationtest']:
            self._query_new_task(taskname, status=status)

    def _query_new_task(self, taskname, status=False):
        current_task_path = os.path.join(self._workdir, 'tasks/' + taskname + '/current')
        meta_path = os.path.join(current_task_path, 'meta.json')
        if not os.path.exists(meta_path):
            if status:
                self._sendTo(self._flood_channels, "No current " + taskname + " completed")
            return

        f = open(meta_path)
        metadata = json.load(f)
        f.close()
        
        taskver = metadata['taskVersion']
        success = metadata['success']

        last_state = self._last_task_state.get(taskname)
        last_version = last_state['version'] if last_state else None
        version_unchanged = taskver == last_version
        last_success = last_state['success'] if last_state else None
        success_changed = last_success != success
        if (not status and version_unchanged):
            return

        msg = 'gnostree:' + taskname
        print msg + "changed (success_changed: %s)" % (success_changed, )

        new_state = {'version': taskver,
                     'success': success}
        self._last_task_state[taskname] = new_state
        success_str = success and 'successful' or 'failed'
        millis = float(metadata['elapsedMillis'])
        msg += " %s: %s in %.1f seconds. " % (taskver, success_str, millis / 1000.0)

        status_path = os.path.join(current_task_path, 'status.txt')
        if os.path.exists(status_path):
            f = open(status_path)
            status_msg = f.read().strip()
            f.close()
            msg += status_msg + ' '

        msg += self._workurl + "tasks/" + taskname + "/%s/%s/output.txt" % (success_str, taskver)

        if not success:
            msg = ircutils.mircColor(msg, fg='red')
        else:
            msg = ircutils.mircColor(msg, fg='green')

        self._sendTo(self._flood_channels, msg)
        if success_changed:
            self._sendTo(self._status_channels, msg)

    def buildstatus(self, irc, msg, args):
        self._query_new_tasks(status=True)

Class = GNOMEOSTree
