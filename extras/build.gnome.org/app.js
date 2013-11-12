(function(exports) {
    'use strict';

    var bgo = angular.module('build.gnome.org', [
        'ngRoute',
        'bgoControllers',
    ]);

    bgo.config(['$routeProvider', function($routeProvider) {
        $routeProvider.
            when('/', {
                templateUrl: 'partials/home.html'
            }).
            when('/jhbuild-ubuntu-raring', {
                templateUrl: 'partials/jhbuild-ubuntu-raring.html'
            }).
            when('/gnome-continuous', {
                templateUrl: 'partials/gnome-continuous.html',
                controller: 'ContinuousTaskViewCtrl',
            }).
            otherwise({
                redirectTo: '/',
            });
    }]);

})(window);
