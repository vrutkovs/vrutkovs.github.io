(function(exports) {
    'use strict';

    var bgo = angular.module('build.gnome.org', [
        'ngRoute',
        'bgoControllers',
    ]);

    bgo.config(['$routeProvider', function($routeProvider) {
        $routeProvider.
            when('/', {
                templateUrl: 'partials/gnome-continuous.html',
                controller: 'ContinuousHomeCtrl',
            }).
            when('/build/:buildVersion', {
                templateUrl: 'partials/gnome-continuous-build.html',
                controller: 'ContinuousBuildViewCtrl',
            }).
            when('/build/:buildVersion/screenshots/:task', {
                templateUrl: 'partials/gnome-continuous-screenshots.html',
                controller: 'ContinuousScreenshotCtrl',
            }).
            otherwise({
                redirectTo: '/',
            });
    }]);

})(window);
