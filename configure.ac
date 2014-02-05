AC_PREREQ([2.63])
AC_INIT([gnome-continuous], [2012.4], [walters@verbum.org], [gnome-continuous], [https://wiki.gnome.org/Projects/GnomeContinuous])
AC_CONFIG_HEADER([config.h])
AC_CONFIG_MACRO_DIR([m4])
AC_CONFIG_AUX_DIR([build-aux])

AM_INIT_AUTOMAKE([1.11 -Wno-portability foreign no-define tar-ustar no-dist-gzip dist-xz])
AM_MAINTAINER_MODE([enable])
AM_SILENT_RULES([yes])

AC_PROG_CC
AM_PROG_CC_C_O

changequote(,)dnl
if test "x$GCC" = "xyes"; then
  WARN_CFLAGS="-Wall -Werror=strict-prototypes -Werror=missing-prototypes \
		-Werror=implicit-function-declaration \
		-Werror=pointer-arith -Werror=init-self -Werror=format=2 \
		-Werror=format-security \
		-Werror=missing-include-dirs -Werror=aggregate-return \
		-Werror=declaration-after-statement"
fi
changequote([,])dnl
AC_SUBST(WARN_CFLAGS)

# Initialize libtool
LT_PREREQ([2.2.4])
LT_INIT([disable-static])

GOBJECT_INTROSPECTION_REQUIRE([1.34.0])

AC_ARG_ENABLE(buildsystem,
	    AS_HELP_STRING([--disable-buildsystem], [Don't install buildsystem]),,
	    enable_buildsystem=yes)
AM_CONDITIONAL(BUILDSYSTEM, test x$enable_buildsystem != xno)

PKG_CHECK_MODULES(GIO_UNIX, [gio-unix-2.0 >= 2.34.0])
GIO_UNIX_CFLAGS="$GIO_UNIX_CFLAGS -DGLIB_VERSION_MIN_REQUIRED=GLIB_VERSION_2_34 -DGLIB_VERSION_MAX_ALLOWED=GLIB_VERSION_2_34"

AC_CONFIG_FILES([
Makefile
])
AC_OUTPUT

echo "
    GNOME-Continuous $VERSION
"
