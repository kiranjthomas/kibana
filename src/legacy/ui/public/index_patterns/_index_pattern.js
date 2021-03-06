/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import _ from 'lodash';
import { SavedObjectNotFound, DuplicateField, IndexPatternMissingIndices } from '../errors';
import angular from 'angular';
import { fieldFormats } from '../registry/field_formats';
import UtilsMappingSetupProvider from '../utils/mapping_setup';
import { toastNotifications } from '../notify';

import { getComputedFields } from './_get_computed_fields';
import { formatHit } from './_format_hit';
import { IndexPatternsGetProvider } from './_get';
import { FieldList } from './_field_list';
import { IndexPatternsFlattenHitProvider } from './_flatten_hit';
import { IndexPatternsPatternCacheProvider } from './_pattern_cache';
import { FieldsFetcherProvider } from './fields_fetcher_provider';
import { SavedObjectsClientProvider, findObjectByTitle } from '../saved_objects';
import { i18n } from '@kbn/i18n';

export function getRoutes() {
  return {
    edit: '/management/kibana/index_patterns/{{id}}',
    addField: '/management/kibana/index_patterns/{{id}}/create-field',
    indexedFields: '/management/kibana/index_patterns/{{id}}?_a=(tab:indexedFields)',
    scriptedFields: '/management/kibana/index_patterns/{{id}}?_a=(tab:scriptedFields)',
    sourceFilters: '/management/kibana/index_patterns/{{id}}?_a=(tab:sourceFilters)'
  };
}

const MAX_ATTEMPTS_TO_RESOLVE_CONFLICTS = 3;

export function IndexPatternProvider(Private, config, Promise) {
  const getConfig = (...args) => config.get(...args);
  const getIds = Private(IndexPatternsGetProvider)('id');
  const fieldsFetcher = Private(FieldsFetcherProvider);
  const mappingSetup = Private(UtilsMappingSetupProvider);
  const flattenHit = Private(IndexPatternsFlattenHitProvider);
  const patternCache = Private(IndexPatternsPatternCacheProvider);
  const savedObjectsClient = Private(SavedObjectsClientProvider);
  const fieldformats = fieldFormats;

  const type = 'index-pattern';
  const configWatchers = new WeakMap();

  const mapping = mappingSetup.expandShorthand({
    title: 'text',
    timeFieldName: 'keyword',
    intervalName: 'keyword',
    fields: 'json',
    sourceFilters: 'json',
    fieldFormatMap: {
      type: 'text',
      _serialize(map = {}) {
        const serialized = _.transform(map, serializeFieldFormatMap);
        return _.isEmpty(serialized) ? undefined : angular.toJson(serialized);
      },
      _deserialize(map = '{}') {
        return _.mapValues(angular.fromJson(map), deserializeFieldFormatMap);
      }
    },
    type: 'keyword',
    typeMeta: 'json',
  });

  function serializeFieldFormatMap(flat, format, field) {
    if (format) {
      flat[field] = format;
    }
  }

  function deserializeFieldFormatMap(mapping) {
    const FieldFormat = fieldformats.byId[mapping.id];
    return FieldFormat && new FieldFormat(mapping.params, getConfig);
  }

  function updateFromElasticSearch(indexPattern, response, forceFieldRefresh = false) {
    if (!response.found) {
      throw new SavedObjectNotFound(
        type,
        indexPattern.id,
        '#/management/kibana/index_pattern',
      );
    }

    _.forOwn(mapping, (fieldMapping, name) => {
      if (!fieldMapping._deserialize) {
        return;
      }
      response._source[name] = fieldMapping._deserialize(response._source[name]);
    });

    // give index pattern all of the values in _source
    _.assign(indexPattern, response._source);

    if (!indexPattern.title) {
      indexPattern.title = indexPattern.id;
    }

    return indexFields(indexPattern, forceFieldRefresh);
  }

  function isFieldRefreshRequired(indexPattern) {
    if (!indexPattern.fields) {
      return true;
    }

    return indexPattern.fields.every(field => {
      // See https://github.com/elastic/kibana/pull/8421
      const hasFieldCaps = ('aggregatable' in field) && ('searchable' in field);

      // See https://github.com/elastic/kibana/pull/11969
      const hasDocValuesFlag = ('readFromDocValues' in field);

      return !hasFieldCaps || !hasDocValuesFlag;
    });
  }

  function indexFields(indexPattern, forceFieldRefresh = false) {
    let promise = Promise.resolve();

    if (!indexPattern.id) {
      return promise;
    }

    if (forceFieldRefresh || isFieldRefreshRequired(indexPattern)) {
      promise = indexPattern.refreshFields();
    }

    return promise.then(() => {
      initFields(indexPattern);
    });
  }

  function setId(indexPattern, id) {
    indexPattern.id = id;
    return id;
  }

  function setVersion(indexPattern, version) {
    indexPattern.version = version;
    return version;
  }

  function watch(indexPattern) {
    if (configWatchers.has(indexPattern)) {
      return;
    }
    const unwatch = config.watchAll(() => {
      if (indexPattern.fields) {
        initFields(indexPattern); // re-init fields when config changes, but only if we already had fields
      }
    });
    configWatchers.set(indexPattern, { unwatch });
  }

  function unwatch(indexPattern) {
    if (!configWatchers.has(indexPattern)) {
      return;
    }
    configWatchers.get(indexPattern).unwatch();
    configWatchers.delete(indexPattern);
  }

  function initFields(indexPattern, input) {
    const oldValue = indexPattern.fields;
    const newValue = input || oldValue || [];
    indexPattern.fields = new FieldList(indexPattern, newValue);
  }

  function fetchFields(indexPattern) {
    return Promise.resolve()
      .then(() => fieldsFetcher.fetch(indexPattern))
      .then(fields => {
        const scripted = indexPattern.getScriptedFields();
        const all = fields.concat(scripted);
        initFields(indexPattern, all);
      });
  }

  class IndexPattern {
    constructor(id) {
      setId(this, id);
      this.metaFields = config.get('metaFields');
      this.getComputedFields = getComputedFields.bind(this);

      this.flattenHit = flattenHit(this);
      this.formatHit = formatHit(this, fieldformats.getDefaultInstance('string'));
      this.formatField = this.formatHit.formatField;
    }

    get routes() {
      return getRoutes();
    }

    init(forceFieldRefresh = false) {
      watch(this);

      if (!this.id) {
        return Promise.resolve(this); // no id === no elasticsearch document
      }

      return savedObjectsClient.get(type, this.id)
        .then(resp => {
          // temporary compatability for savedObjectsClient

          setVersion(this, resp._version);

          return {
            _id: resp.id,
            _type: resp.type,
            _source: _.cloneDeep(resp.attributes),
            found: resp._version ? true : false
          };
        })
        // Do this before we attempt to update from ES
        // since that call can potentially perform a save
        .then(response => {
          this.originalBody = this.prepBody();
          return response;
        })
        .then(response => updateFromElasticSearch(this, response, forceFieldRefresh))
        // Do it after to ensure we have the most up to date information
        .then(() => {
          this.originalBody = this.prepBody();
        })
        .then(() => this);
    }

    // Get the source filtering configuration for that index.
    getSourceFiltering() {
      return {
        excludes: this.sourceFilters && this.sourceFilters.map(filter => filter.value) || []
      };
    }

    addScriptedField(name, script, type = 'string', lang) {
      const scriptedFields = this.getScriptedFields();
      const names = _.pluck(scriptedFields, 'name');

      if (_.contains(names, name)) {
        throw new DuplicateField(name);
      }

      this.fields.push({
        name: name,
        script: script,
        type: type,
        scripted: true,
        lang: lang
      });

      this.save();
    }

    removeScriptedField(name) {
      const fieldIndex = _.findIndex(this.fields, {
        name: name,
        scripted: true
      });

      if(fieldIndex > -1) {
        this.fields.splice(fieldIndex, 1);
        delete this.fieldFormatMap[name];
        return this.save();
      }
    }

    popularizeField(fieldName, unit = 1) {
      const field = _.get(this, ['fields', 'byName', fieldName]);
      if (!field) {
        return;
      }
      const count = Math.max((field.count || 0) + unit, 0);
      if (field.count === count) {
        return;
      }
      field.count = count;
      this.save();
    }

    getNonScriptedFields() {
      return _.where(this.fields, { scripted: false });
    }

    getScriptedFields() {
      return _.where(this.fields, { scripted: true });
    }

    isTimeBased() {
      return !!this.timeFieldName && (!this.fields || !!this.getTimeField());
    }

    isTimeNanosBased() {
      const timeField = this.getTimeField();
      return timeField && timeField.esTypes && timeField.esTypes.indexOf('date_nanos') !== -1;
    }

    isTimeBasedWildcard() {
      return this.isTimeBased() && this.isWildcard();
    }

    getTimeField() {
      if (!this.timeFieldName || !this.fields || !this.fields.byName) return;
      return this.fields.byName[this.timeFieldName];
    }

    isWildcard() {
      return _.includes(this.title, '*');
    }

    prepBody() {
      const body = {};

      // serialize json fields
      _.forOwn(mapping, (fieldMapping, fieldName) => {
        if (this[fieldName] != null) {
          body[fieldName] = (fieldMapping._serialize)
            ? fieldMapping._serialize(this[fieldName])
            : this[fieldName];
        }
      });

      // clear the indexPattern list cache
      getIds.clearCache();
      return body;
    }

    async create(allowOverride = false) {
      const _create = async (duplicateId) => {
        if (duplicateId) {
          const duplicatePattern = new IndexPattern(duplicateId);
          await duplicatePattern.destroy();
        }

        const body = this.prepBody();
        const response = await savedObjectsClient.create(type, body, { id: this.id });
        return setId(this, response.id);
      };

      const potentialDuplicateByTitle = await findObjectByTitle(savedObjectsClient, type, this.title);
      // If there is potentially duplicate title, just create it
      if (!potentialDuplicateByTitle) {
        return await _create();
      }

      // We found a duplicate but we aren't allowing override, show the warn modal
      if (!allowOverride) {
        return false;
      }

      return await _create(potentialDuplicateByTitle.id);
    }

    save(saveAttempts = 0) {
      const body = this.prepBody();
      // What keys changed since they last pulled the index pattern
      const originalChangedKeys = Object.keys(body).filter(key => body[key] !== this.originalBody[key]);
      return savedObjectsClient.update(type, this.id, body, { version: this.version })
        .then(({ id, _version }) => {
          setId(this, id);
          setVersion(this, _version);
        })
        .catch(err => {
          if (_.get(err, 'res.status') === 409 && saveAttempts++ < MAX_ATTEMPTS_TO_RESOLVE_CONFLICTS) {
            const samePattern = new IndexPattern(this.id);
            return samePattern.init()
              .then(() => {
                // What keys changed from now and what the server returned
                const updatedBody = samePattern.prepBody();

                // Build a list of changed keys from the server response
                // and ensure we ignore the key if the server response
                // is the same as the original response (since that is expected
                // if we made a change in that key)
                const serverChangedKeys = Object.keys(updatedBody).filter(key => {
                  return updatedBody[key] !== body[key] && this.originalBody[key] !== updatedBody[key];
                });

                let unresolvedCollision = false;
                for (const originalKey of originalChangedKeys) {
                  for (const serverKey of serverChangedKeys) {
                    if (originalKey === serverKey) {
                      unresolvedCollision = true;
                      break;
                    }
                  }
                }

                if (unresolvedCollision) {
                  const message = i18n.translate(
                    'common.ui.indexPattern.unableWriteLabel',
                    { defaultMessage: 'Unable to write index pattern! Refresh the page to get the most up to date changes for this index pattern.' } // eslint-disable-line max-len
                  );
                  toastNotifications.addDanger(message);
                  throw err;
                }

                // Set the updated response on this object
                serverChangedKeys.forEach(key => {
                  this[key] = samePattern[key];
                });

                setVersion(this, samePattern.version);

                // Clear cache
                patternCache.clear(this.id);

                // Try the save again
                return this.save(saveAttempts);
              });
          }
          throw err;
        });
    }

    refreshFields() {
      return fetchFields(this)
        .then(() => this.save())
        .catch((err) => {
          // https://github.com/elastic/kibana/issues/9224
          // This call will attempt to remap fields from the matching
          // ES index which may not actually exist. In that scenario,
          // we still want to notify the user that there is a problem
          // but we do not want to potentially make any pages unusable
          // so do not rethrow the error here
          if (err instanceof IndexPatternMissingIndices) {
            toastNotifications.addDanger(err.message);
            return [];
          }

          toastNotifications.addError(err, {
            title: i18n.translate('common.ui.indexPattern.fetchFieldErrorTitle', {
              defaultMessage: 'Error fetching fields',
            }),
          });
          throw err;
        });
    }

    toJSON() {
      return this.id;
    }

    toString() {
      return '' + this.toJSON();
    }

    destroy() {
      unwatch(this);
      patternCache.clear(this.id);
      return savedObjectsClient.delete(type, this.id);
    }
  }

  return IndexPattern;
}
