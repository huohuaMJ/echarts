define(function(require) {

    var echarts = require('../echarts');
    var zrUtil = require('zrender/core/util');
    var modelUtil = require('../util/model');
    var graphicUtil = require('../util/graphic');
    var formatUtil = require('../util/format');
    var layoutUtil = require('../util/layout');

    // Preprocessor
    echarts.registerPreprocessor(function (option) {
        var graphicOption = option && option.graphic;

        // Only one graphic instance can be instantiated. (We dont
        // want that too many views created in echarts._viewMap)

        // Convert
        // {graphic: [{left: 10, type: 'circle'}, ...]}
        // or
        // {graphic: {left: 10, type: 'circle'}}
        // to
        // {graphic: [{elements: [{left: 10, type: 'circle'}, ...]}]}
        if (zrUtil.isArray(graphicOption)) {
            if (!graphicOption[0] || !graphicOption[0].elements) {
                option.graphic = [{elements: graphicOption}];
            }
        }
        else if (graphicOption && !graphicOption.elements) {
            option.graphic = [{elements: [graphicOption]}];
        }
    });

    // Model
    var GraphicModel = echarts.extendComponentModel({

        type: 'graphic',

        defaultOption: {
            // Besides settings of graphic elements, each element
            // can be set with: left, right, top, bottom, width, height.
            // If left or rigth is set, final location X is totally decided by them.
            // If top or bottom is set, final location Y is totally decided by them.
            // Otherwise location is decided by shape setting.
            // This mechanism is useful when you want position a group against the
            // right side of this container, where you do not need to consider the
            // settings of elements in this group.
            elements: [],
            parentId: null
        },

        /**
         * Save for performance (only update needed graphics).
         * The order is the same as those in option. (ancesters -> descendants)
         * @private
         * @type {Array.<Object>}
         */
        _elOptionsToUpdate: null,

        /**
         * @override
         */
        mergeOption: function (option) {
            // Prevent default merge to elements
            var elements = this.option.elements;
            this.option.elements = null;

            GraphicModel.superApply(this, 'mergeOption', arguments);

            this.option.elements = elements;
        },

        /**
         * @override
         */
        optionUpdated: function (newOption, isInit) {
            var thisOption = this.option;
            var newList = (isInit ? thisOption : newOption).elements;
            var existList = thisOption.elements = isInit ? [] : thisOption.elements;

            var flattenedList = [];
            this._flatten(newList, flattenedList);

            var mappingResult = modelUtil.mappingToExists(existList, flattenedList);
            modelUtil.makeIdAndName(mappingResult);

            // Clear elOptionsToUpdate
            var elOptionsToUpdate = this._elOptionsToUpdate = [];

            zrUtil.each(mappingResult, function (resultItem, index) {
                var existElOption = resultItem.exist;
                var newElOption = resultItem.option;

                if (__DEV__) {
                    zrUtil.assert(
                        zrUtil.isObject(newElOption) || existElOption,
                        'Empty graphic option definition'
                    );
                }

                if (!newElOption) {
                    return;
                }

                // Set id and parent id after id assigned.
                newElOption.id = resultItem.keyInfo.id;
                var newElParentId = newElOption.parentId;
                var newElParentOption = newElOption.parentOption;
                var existElParentId = existElOption && existElOption.parentId;
                !newElOption.type && existElOption && (newElOption.type = existElOption.type);
                newElOption.parentId = newElParentId // parent id specified
                    ? newElParentId
                    : newElParentOption
                    ? newElParentOption.id
                    : existElParentId // parent not specified
                    ? existElParentId
                    : null;
                elOptionsToUpdate.push(newElOption);

                delete newElOption.parentOption; // Clear

                // Update existing options, for `getOption` feature.
                var newElOptCopy = zrUtil.extend({}, newElOption); // Avoid modified.
                var $action = newElOption.$action;
                if (!$action || $action === 'merge') {
                    if (existElOption) {
                        // We can ensure that newElOptCopy and existElOption are not
                        // the same object, so merge will not change newElOptCopy.
                        zrUtil.merge(existElOption, newElOptCopy, true);
                        layoutUtil.mergeLayoutParam(existElOption, newElOptCopy);
                        // Will be used in render.
                        layoutUtil.copyLayoutParams(newElOption, existElOption);
                    }
                    else {
                        existList[index] = newElOptCopy;
                    }
                }
                else if ($action === 'replace') {
                    existList[index] = newElOptCopy;
                }
                else if ($action === 'remove') {
                    // null will be cleaned later.
                    existElOption && (existList[index] = null);
                }

            }, this);

            // Clean
            for (var i = existList.length - 1; i >= 0; i--) {
                if (existList[i] == null) {
                    existList.splice(i, 1);
                }
                else {
                    // $action should be volatile, otherwise option gotten from
                    // `getOption` will contain unexpected $action.
                    delete existList[i].$action;
                }
            }
        },

        /**
         * Convert
         * [{
         *  type: 'group',
         *  id: 'xx',
         *  children: [{type: 'circle'}, {type: 'polygon'}]
         * }]
         * to
         * [
         *  {type: 'group', id: 'xx'},
         *  {type: 'circle', parentId: 'xx'},
         *  {type: 'polygon', parentId: 'xx'}
         * ]
         * @private
         */
        _flatten: function (optionList, result, parentOption) {
            zrUtil.each(optionList, function (option) {
                if (option) {
                    if (parentOption) {
                        option.parentOption = parentOption;
                    }

                    result.push(option);

                    var children = option.children;
                    if (option.type === 'group' && children) {
                        this._flatten(children, result, option);
                    }
                    // For JSON output, and do not affect group creation.
                    delete option.children;
                }
            }, this);
        },

        // FIXME
        // Pass to view using payload? setOption has a payload?
        useElOptionsToUpdate: function () {
            var els = this._elOptionsToUpdate;
            // Clear to avoid render duplicately when zooming.
            this._elOptionsToUpdate = null;
            return els;
        }
    });

    // View
    echarts.extendComponentView({

        type: 'graphic',

        /**
         * @override
         */
        init: function (ecModel, api) {

            /**
             * @type {Object}
             */
            this._elMap = {};
        },

        /**
         * @override
         */
        render: function (graphicModel, ecModel, api) {
            var elOptionsToUpdate = graphicModel.useElOptionsToUpdate();
            var elMap = this._elMap;
            var rootGroup = this.group;

            zrUtil.each(elOptionsToUpdate, function (elOption) {
                var $action = elOption.$action;
                var id = elOption.id;
                var existEl = elMap[id];
                var parentId = elOption.parentId;
                var targetElParent = parentId != null ? elMap[parentId] : rootGroup;
                var hvLocUsed = [
                    isSetLoc(elOption, 'left') || isSetLoc(elOption, 'right'),
                    isSetLoc(elOption, 'top') || isSetLoc(elOption, 'bottom')
                ];

                // In top/bottom mode, textVertical should not be used. But
                // textBaseline should not be 'alphabetic', which is not precise.
                if (hvLocUsed[1] && elOption.type === 'text') {
                    elOption.style = zrUtil.defaults({textBaseline: 'middle'}, elOption.style);
                    elOption.style.textVerticalAlign = null;
                }

                // Remove unnecessary props to avoid potential problem.
                var elOptionCleaned = getCleanedElOption(elOption);
                // Notice: the size of this rect is based on previous sibling. So if
                // using left/right/top/bottom, it is based on the previous sibling.
                // Although this mechanism is not perfect, but it is enable you set
                // group rect by prevoius rect children.
                var parentRect = targetElParent.getBoundingRect();
                var currParentWidth = parentRect.width;
                var currParentHeight = parentRect.height;

                if (!$action || $action === 'merge') {
                    if (existEl) {
                        existEl.attr(elOptionCleaned);
                        if (targetElParent !== existEl.parent) {
                            removeEl(id, existEl, elMap);
                            targetElParent.add(existEl);
                        }
                    }
                    else {
                        createEl(id, targetElParent, elOptionCleaned, elMap);
                    }
                }
                else if ($action === 'replace') {
                    removeEl(id, existEl, elMap);
                    createEl(id, targetElParent, elOptionCleaned, elMap);
                }
                else if ($action === 'remove') {
                    removeEl(id, existEl, elMap);
                }

                if (elMap[id]) {
                    elMap[id].__ecGraphicWidth = elOption.width;
                    elMap[id].__ecGraphicHeight = elOption.height;

                    var containerInfo = targetElParent === rootGroup
                        ? {
                            width: api.getWidth(),
                            height: api.getHeight()
                        }
                        : {
                            width: zrUtil.retrieve(targetElParent.__ecGraphicWidth, currParentWidth, 0),
                            height: zrUtil.retrieve(targetElParent.__ecGraphicHeight, currParentHeight, 0)
                        };

                    layoutUtil.positionElement(elMap[id], elOption, containerInfo, null, hvLocUsed);
                }
            });
        },

        /**
         * @override
         */
        dispose: function () {
            this._elMap = {};
        }
    });

    function createEl(id, targetElParent, elOption, elMap) {
        var graphicType = elOption.type;

        if (__DEV__) {
            zrUtil.assert(graphicType, 'graphic type MUST be set');
        }

        var Clz = graphicUtil[formatUtil.toCamelCase(graphicType, true)];

        if (__DEV__) {
            zrUtil.assert(Clz, 'graphic type can not be found');
        }

        var el = new Clz(elOption);
        targetElParent.add(el);
        elMap[id] = el;
    }

    function removeEl(id, existEl, elMap) {
        var existElParent = existEl && existEl.parent;
        if (existElParent) {
            existElParent.remove(existEl);
            delete elMap[id];
        }
    }

    // Remove unnecessary props to avoid potential problem.
    function getCleanedElOption(elOption) {
        elOption = zrUtil.extend({}, elOption);
        zrUtil.each(
            ['id', 'parentId', '$action'].concat(layoutUtil.LOCATION_PARAMS),
            function (name) {
                delete elOption[name];
            }
        );
        return elOption;
    }

    function isSetLoc(obj, prop) {
        return obj[prop] != null && obj[prop] !== 'auto';
    }
});