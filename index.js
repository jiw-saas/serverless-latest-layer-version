'use strict';

/**
 * This Serverless plugin replaces 'latest' pseudo version tag to actual latest version
 */

const util = require('util');
const reg = /^arn:aws:lambda:(?<region>[^:]+):(?<accountId>[^:]+):layer:(?<layerName>[^:]+):serverless-latest-layer-version$/;

class ServerlessPlugin {
  constructor(serverless, options) {

    this.serverless = serverless;
    this.provider = serverless.getProvider("aws");
    this.options = options;
    this.resolvedLayers = new Set();

    this.hooks = {
      'after:aws:package:finalize:mergeCustomProviderResources': this.updateCFNLayerVersion.bind(this),
      'before:deploy:function:deploy': this.updateSLSLayerVersion.bind(this),
    };
  }

  updateSLSLayerVersion() {
    // Find All Lambda Layer associations from compiled serverless configuration
    return this.update(this.listSLSLayerAssociations());
  }

  updateCFNLayerVersion() {
    // Find All Lambda Layer associations from compiled CFN template
    return this.update(this.listCFNLayerAssociations());
  }

  async update(layersList) {
    const layerAssociation = {};

    for (const layers of layersList) {
      if (!Array.isArray(layers)) {
        continue
      }
      layers.forEach(
        (layer, index) => {
          const layerName = this.extractLayerName(layer);
          if (!layerName) {
            return;
          }
          const listener = (newLayer) => {
            layers[index] = newLayer;
          };
          let listeners = layerAssociation[layerName];
          if (!listeners) {
            layerAssociation[layerName] = [listener];
          } else {
            listeners.push(listener);
          }
        }
      )
    }

    await Promise.all(
      Object.entries(layerAssociation)
        .map(([layerName, listeners]) => this.processLayers(layerName, listeners))
    );
  }

  listCFNLayerAssociations() {
    // Lookup compiled CFN template to support individual deployments
    const compiledTemplate = this.serverless.service.provider.compiledCloudFormationTemplate;
    return Object.values(compiledTemplate.Resources)
      .filter(({ Type }) => Type === 'AWS::Lambda::Function')
      .map(resource => resource.Properties?.Layers);
  }

  listSLSLayerAssociations() {
    return Object.values(this.serverless.service?.functions ?? {}).map(({ layers }) => layers);
  }

  async processLayers(layerName, listeners) {
    let latestVersion;

    this.debug("Fetching versions for", layerName);
    let marker;
    do {
      const result = await this.provider.request("Lambda", "listLayerVersions", {
        LayerName: layerName,
        Marker: marker,
      });
      this.debug("Result", result);
      for (const version of result.LayerVersions) {
        if (latestVersion && latestVersion.Version > version.Version) {
          continue;
        }
        latestVersion = version;
      }
      marker = result.NextMarker;
    } while (marker);

    if (!latestVersion) {
      throw new Error(`Lambda layer ${layerName} has no version available.`);
      return;
    } else {
      this.debug(`Latest version for ${layerName} → `, latestVersion);
    }

    for (const listener of listeners) {
      listener(latestVersion.LayerVersionArn);
    }
  }

  extractLayerName(layer) {
    if (!layer) {
      return;
    }
    if (typeof layer !== 'string') {
      this.debug('Skipping layer as its not a string:', layer);
      return;
    }
    const tokens = reg.exec(layer)
    if (!tokens) {
      this.debug(`Skipping layer ${layer} as it doesn't match regexp: ${reg}`);
      return;
    }

    let { region, accountId, layerName, layerVersion } = tokens.groups || {};
    if (layerVersion === '?') {
      layerVersion = 'latest'
    } else if (layerVersion === parseInt(layerVersion)) {
      this.debug(`Skipping layer ${layer} as it has a clearly specified layer version.`);
      return;
    }
    if (region === "?") {
      region = this.serverless.service.provider.region;
    }
    return accountId === "?"
        ? layerName
        : `arn:aws:lambda:${region}:${accountId}:layer:${layerName}`;
  }

  debug(...args) {
    const TAG = '[serverless-latest-layer-version]';

    if (typeof args[0] === 'string') {
      args[0] = `${TAG} ${args[0]}`;
    } else {
      args.unshift(TAG);
    }

    this.serverless.cli.debug(util.format(...args));
  }
}

module.exports = ServerlessPlugin;
