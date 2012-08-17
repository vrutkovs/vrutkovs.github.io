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

git config --global user.name "GNOME-OSTree builder"
git config --global user.email "gnome-ostree@internal"

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
cat >> conf/local.conf <<EOF 
DISTRO=gnomeosdistro
PARALLEL_MAKE = "-j $(getconf _NPROCESSORS_ONLN)"
BB_NUMBER_THREADS = "$(getconf _NPROCESSORS_ONLN)"
EOF
)

ln -s ~/build/gnomeos-build/tmp-eglibc/deploy/images/repo ~/build/gnomeos-build

mkdir -p ~/public_html
cd ~/public_html
ln -s ~/build/gnomeos-build/repo .
ln -s ~/build/ostbuild/work/logs logs

cp ~/src/gnome-ostree/qa/repoweb/* .

mkdir -p ~/.config
cat > ~/.config/ostbuild.cfg <<EOF
[global]
repo=~/build/gnomeos-build/repo
mirrordir=~/build/src-mirror
workdir=~/build/ostbuild
EOF

PATH=~/.local/bin:$PATH

jhbuild run ostbuild init

jhbuild run ostbuild prefix gnomeos-3.6
