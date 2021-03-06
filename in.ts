#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import * as util from "util";

import fetch from "node-fetch";

import { createFetchHeaders, retrieveRequestFromStdin } from "./index";
import { IInRequest, IResponse } from "./index";
import { IHarborChartJSON } from "./types";

// Promisified funtions from the Node.js standard library.
const writeFile = util.promisify(fs.writeFile);

(async () => {

    // Determine destination path.
    if (process.argv.length !== 3) {
        process.stderr.write(`Expected exactly one argument (destination), got ${process.argv.length - 2}.`);
        process.exit(2);
    }
    const destination = path.resolve(process.argv[2]);

    const request = await retrieveRequestFromStdin<IInRequest>();

    const headers = createFetchHeaders(request);

    // Fetch metadata
    const chartResp = await fetch(
        `${request.source.server_url}api/chartrepo/${request.source.project}/charts/${request.source.chart_name}/${request.version.version}`,
        { headers });
    const chartJson: IHarborChartJSON = await chartResp.json();

    // Read params and pre-initialize them with documented default values.
    let targetBasename: string = `${chartJson.metadata.name}-${chartJson.metadata.version}`;
    if (request.params != null) {
        if (request.params.target_basename != null) {
            targetBasename = request.params.target_basename;
        }
    }

    const response: IResponse = {
        metadata: [
            { name: "created", value: chartJson.metadata.created },
            { name: "description", value: chartJson.metadata.description },
            { name: "appVersion", value: chartJson.metadata.appVersion },
        ],
        version: {
            digest: chartJson.metadata.digest,
            version: chartJson.metadata.version,
        },
    };

    const tgzResp = await fetch(
        `${request.source.server_url}chartrepo/${request.source.project}/charts/${request.source.chart_name}-${chartJson.metadata.version}.tgz`,
        { headers });
    await writeFile(path.resolve(destination, `${targetBasename}.tgz`), await tgzResp.buffer());

    const provResp = await fetch(
        `${request.source.server_url}chartrepo/${request.source.project}/charts/${request.source.chart_name}-${chartJson.metadata.version}.tgz.prov`,
        { headers });
    await writeFile(path.resolve(destination, `${targetBasename}.tgz.prov`), await provResp.buffer());
    await writeFile(path.resolve(destination, `${targetBasename}.json`), JSON.stringify(chartJson));
    process.stdout.write(JSON.stringify(response, null, 2));
})();
