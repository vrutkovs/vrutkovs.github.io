#!/bin/sh
# Set up ostree user
#
# Copyright (C) 2012 Colin Walters <walters@verbum.org>
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

set -e
set -x

cd ${HOME}
mkdir -p src
cd src
test -d jhbuild || git clone --depth=1 git://git.gnome.org/jhbuild

cd ~/src/jhbuild
./autogen.sh
make
make install

cat > ${HOME}/.jhbuildrc << END
modulesets_dir = '~/src/gnome-ostree/install'
moduleset = 'ostree'
modules = ['gnome-ostree']
checkoutroot = '~/src'
prefix = '~/build/jhbuild'
use_local_modulesets = True
END

~/.local/bin/jhbuild build gnome-ostree </dev/null

cd ~/src
test -d poky || git clone --depth=1 -b gnomeos-3.6 git://github.com/cgwalters/poky poky
mkdir -p ~/build
cd ~/build
(
. ~/src/poky/oe-init-build-env gnomeos-build
cat > conf/bblayers.conf << END
LCONF_VERSION = "4"
BBFILES ?= ""
BBLAYERS = " \
  ${HOME}/src/poky/meta \
  ${HOME}/src/poky/meta-yocto \
  ${HOME}/src/poky/meta-gnomeos \
  "
END
)

ln -s ~/build/gnomeos-build/tmp/deploy/images/repo ~/build/gnomeos-build

mkdir -p ~/public_html
cd ~/public_html
ln -s ~/build/gnomeos-build/repo .
ln -s ~/build/ostbuild/work/logs logs

cp ~/src/gnome-ostree/qa/repoweb/* .

