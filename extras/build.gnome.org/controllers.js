(function(exports) {
    'use strict';

    var bgoControllers = angular.module('bgoControllers', []);

    var taskNames = ['build', 'smoketest', 'integrationtest', 'applicationstest'];

    function getUrl(suffix) {
        return window.location.protocol + '//' + window.location.host +
            window.location.pathname + 'continuous/buildmaster/' + suffix;
    }

    function getContinuousTask($http, taskName) {
        return $http.get(getUrl('results/tasks/' + taskName + '/' + taskName + '/meta.json'));
    }

    bgoControllers.controller('ContinuousStatusCtrl', function($scope, $http) {
        getContinuousTask($http, 'build').success(function(data) {
            $scope.status = data.success ? 'good' : 'bad';
            $scope.buildName = data.buildName;
        });
    });

    bgoControllers.controller('ContinuousTaskViewCtrl', function($scope, $http) {
        $scope.getUrl = getUrl;

        $http.get(getUrl('autobuilder-status.json')).success(function(status) {
            var text;
            if (status.running.length > 0)
                text = 'Running: ' + status.running.join(' ') + '; load=' + status.systemLoad[0];
            else
                text = 'Idle, awaiting commits';

            $scope.runningState = text;
        });

        var tasks = [];
        taskNames.forEach(function(taskName) {
            getContinuousTask($http, taskName).success(function(data) {
                // Mangle the data a bit so we can render it better
                data['name'] = taskName;

                tasks.push(data);

                if (taskName == 'smoketest')
                    $scope.smoketestImage = getUrl(data['path'] + '/work-gnome-continuous-x86_64-runtime/screenshot-final.png');
            });
        });

        $scope.tasks = tasks;
    });

})(window);
