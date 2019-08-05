#!/usr/bin/env node

import * as child_process from "child_process";
import * as FormData from "form-data";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as rimraf from "rimraf";
import * as semver from "semver";
import * as util from "util";

import fetch, { Response } from "node-fetch";
import * as tmp from "tmp";
import * as yaml from "yamljs";

import lineReader = require("line-reader");
import { StringDecoder } from "string_decoder";
import { URLSearchParams } from "url";
import { createFetchHeaders, retrieveRequestFromStdin } from "./index";
import { IOutRequest, IResponse } from "./index";
import { IHarborChartJSON } from "./types";

const exec = util.promisify(child_process.exec);
const lstat = util.promisify(fs.lstat);
const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);
const mkdtemp = util.promisify(fs.mkdtemp);
const deltree = util.promisify(rimraf);

async function createTmpDir(): Promise<{ path: string, cleanupCallback: () => void }> {
  return new Promise<{ path: string, cleanupCallback: () => void }>((resolve, reject) => {
    tmp.dir((err, pathVal, cleanupCallback) => {
      if (err) {
        reject(err);
      } else {
        resolve({
          cleanupCallback,
          path: pathVal,
        });
      }
    });
  });
}

async function importGpgKey(gpgHome: string, keyFile: string, passphrase?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let importResult = "";
    const importProcess = child_process.spawn("gpg", [
      "--batch",
      "--homedir",
      `"${path.resolve(gpgHome)}"`,
      "--import",
      `"${path.resolve(keyFile)}"`,
    ]);
    if (passphrase != null) {
      importProcess.stdin.write(passphrase);
    }
    importProcess.stdin.end();
    importProcess.stderr.on("data", (data) => {
      importResult += data;
    });
    importProcess.stdout.on("data", (data) => {
      process.stderr.write(data);
    });
    importProcess.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`gpg import returned exit code ${code}.`));
      } else {
        const keyIdLine = importResult.split(/\r?\n/).find((line) => line.includes("secret key imported"));
        if (keyIdLine == null) {
          reject("Unable to determine Key ID after successful import: Line with key ID not found.");
        } else {
          const match = /^gpg\:\ key\ (.*?)\: secret\ key\ imported$/.exec(keyIdLine);
          if (match == null) {
            reject("Unable to determine Key ID after successful import: Regex match failure.");
          } else {
            resolve(match[1]);
          }
        }
      }
    });
  });
}

export default async function out(): Promise<{ data: object, cleanupCallback: (() => void) | undefined }> {

  let cleanupCallback: (() => void) | undefined;

  // Determine build path and decend into it.
  // if (process.argv.length !== 3) {
  //     process.stderr.write(`Expected exactly one argument (root), got ${process.argv.length - 2}.\n`);
  //     process.exit(102);
  // }
  // const root = path.resolve(process.argv[2]);
  const root = path.resolve("./");
  process.chdir(root);

  let request: IOutRequest;
  try {
    request = await retrieveRequestFromStdin<IOutRequest>();
  } catch (e) {
    process.stderr.write("Unable to retrieve JSON data from stdin.\n");
    process.stderr.write(e);
    process.exit(502);
    throw (e);
  }

  let headers = createFetchHeaders(request);

  // If either params.version or params.version_file have been specified,
  // we'll read our version information for packaging the Helm Chart from
  // there.
  const appVersion = request.params.app_version;
  let version = request.params.version;
  if (request.params.version_file != null) {
    const versionFile = path.resolve(request.params.version_file);
    if ((await lstat(versionFile)).isFile()) {
      // version_file exists. Cool... let's read it's contents.
      version = (await readFile(versionFile)).toString().replace(/\r?\n/, "");
    }
  }
  if (version != null && request.source.version_range != null) {
    const versionRange = request.source.version_range;
    if (!semver.satisfies(version, versionRange)) {
      process.stderr.write(
        `params.version (${version}) does not satisfy contents of source.version_range (${versionRange}).\n`);
      process.exit(104);
    }
  }

  const chartLocation = path.resolve(request.params.chart);
  process.stderr.write(`Processing chart at "${chartLocation}"...\n`);
  let chartFile: string;
  let chartFileStat = await lstat(chartLocation);
  if (chartFileStat.isDirectory()) {
    const chartInfo = yaml.load(path.resolve(chartLocation, "Chart.yaml"));
    const tmpDir = await createTmpDir();
    cleanupCallback = tmpDir.cleanupCallback;

    if ((await lstat(`${chartLocation}/requirements.yaml`)).isFile()) {
      process.stderr.write("Found requirements.yaml. Adding repo...\n");
      const reqLocation = await (path.resolve(`${chartLocation}/requirements.yaml`));
      const repoRegex = new RegExp(
        /(https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b[-a-zA-Z0-9()@:%_\+.~#?&//=]*)/);
      lineReader.eachLine(reqLocation, async (line) => {
        const matchedGroups = line.match(repoRegex);
        if (matchedGroups) {
          process.stderr.write(`Adding repo ${matchedGroups[0]}...\n`);
          const nameRegex = new RegExp(/\/\/([^\.]*)/);
          const name = matchedGroups[0].match(nameRegex);
          if (name) {
            const helmRepoAdd = [
              "helm",
              "repo",
              "add",
              name[0],
              matchedGroups[0],
            ];
            await exec(helmRepoAdd.join(" "));
          } else {
            process.stderr.write(`Can't capture name from repo: ${matchedGroups[0]}...\n`);
          }
        }
      });
    }
    const helmBuildCmd = [
      "helm",
      "dep",
      "build",
      chartLocation,
    ];

    try {
      process.stderr.write("Performing \"helm dep build\"...\n");
      await exec(helmBuildCmd.join(" "));
    } catch (e) {
      if (e.stderr != null) {
        process.stderr.write(`${e.stderr}\n`);
      }
      process.stderr.write(`Retrieval of chart deps failed.\n`);
      process.exit(121);
    }

    const helmPackageCmd = [
      "helm",
      "package",
      "--destination",
      tmpDir.path,
    ];
    if (request.params.sign === true) {
      const keyData = request.params.key_data;
      let keyFile = request.params.key_file;
      let keyId: string;
      if (keyData == null && keyFile == null) {
        process.stderr.write("Either key_data or key_file must be specified, when 'sign' is set to true.");
        process.exit(332);
      }
      if (keyData != null) {
        keyFile = path.resolve(tmpDir.path, "gpg-key.asc");
        await writeFile(keyFile, keyData);
      }
      const gpgHome: string = path.resolve(await mkdtemp(path.resolve(os.tmpdir(), "concourse-gpg-keyring-")));
      process.stderr.write(`Using new empty temporary GNUPGHOME: "${gpgHome}".\n`);
      try {
        process.stderr.write(`Importing GPG private key: "${keyFile}"...\n`);
        try {
          keyId = await importGpgKey(gpgHome, keyFile as string, request.params.key_passphrase);
        } catch (e) {
          process.stderr.write(`Importing of GPG key "${keyFile}" failed.\n`);
          throw e;
        }
        process.stderr.write(`GPG key imported successfully. Key ID: "${keyId}".\n`);
        helmPackageCmd.push("--sign");
        helmPackageCmd.push("--key");
        helmPackageCmd.push(keyId);
        helmPackageCmd.push("--keyring");
        helmPackageCmd.push(`"${path.resolve(gpgHome, "secring.gpg")}"`);
      } catch (e) {
        process.stderr.write("Signing of chart with GPG private key failed\n");
        throw e;
      } finally {
        process.stderr.write(`Removing temporary GNUPGHOME "${gpgHome}".\n`);
        await deltree(gpgHome);
      }

    }
    if (version != null) {
      helmPackageCmd.push("--version", version);
    }
    if (appVersion != null) {
      helmPackageCmd.push("--app-version", appVersion);
    }
    helmPackageCmd.push(chartLocation);
    try {
      process.stderr.write("Performing \"helm package\"...\n");
      await exec(helmPackageCmd.join(" "));
    } catch (e) {
      if (e.stderr != null) {
        process.stderr.write(`${e.stderr}\n`);
      }
      process.stderr.write(`Packaging of chart file failed.\n`);
      process.exit(121);
    }
    chartFile = path.resolve(tmpDir.path, `${chartInfo.name}-${version != null ? version : chartInfo.version}.tgz`);
    chartFileStat = await lstat(chartFile);
  } else if (chartFileStat.isFile()) {
    chartFile = chartLocation;
  } else {
    process.stderr.write(`Chart file (${chartLocation}) not found.\n`);
    process.exit(110);
    throw new Error(); // Tricking the typescript compiler.
  }

  process.stderr.write(`Inspecting chart file: "${chartFile}"...\n`);

  try {
    const result = await exec(`helm inspect ${chartFile}`);
    if (result.stderr != null && result.stderr.length > 0) {
      process.stderr.write(`${result.stderr}\n`);
    }
    const inspectionResult = result.stdout;
    const versionLine = inspectionResult.split(/\r?\n/).find((line) => line.startsWith("version:"));
    if (versionLine == null) {
      process.stderr.write("Unable to parse version information from Helm Chart inspection result.\n");
      process.exit(121);
    } else {
      version = versionLine.split(/version:\s*/)[1];
    }
  } catch (e) {
    process.stderr.write(`Unable to "inspect" Helm Chart file: ${chartFile}.\n`);
    process.exit(120);
  }

  const formData = new FormData();
  formData.append("chart", fs.createReadStream(chartFile));
  let postResult: Response;
  try {
    let postUrl = `${request.source.server_url}api/chartrepo/${request.source.project}/charts`;
    process.stderr.write(`Uploading chart file: "${chartFile}" to "${postUrl}"... \n`);
    if (request.params.force) {
      postUrl += "?force=true";
    }
    postResult = await fetch(postUrl, {
      body: formData,
      headers,
      method: "POST",
    });
  } catch (e) {
    process.stderr.write("Upload of chart file has failed.\n");
    process.stderr.write(e);
    process.exit(124);
    throw e; // Tricking the typescript compiler.
  }

  if (postResult.status !== 201) {
    process.stderr.write(
      `An error occured while uploading the chart: "${postResult.status} - ${postResult.statusText}".\n`);
    process.exit(postResult.status);
  }

  const postResultJson = await postResult.json();
  if (postResultJson.error != null) {
    process.stderr.write(`An error occured while uploading the chart: "${postResultJson.error}".\n`);
    process.exit(602);
  } else if (postResultJson.saved !== true) {
    process.stderr.write(
      `Helm chart has not been saved. (Return value from server: saved=${postResultJson.saved})\n`);
    process.exit(603);
  }

  process.stderr.write("Helm Chart has been uploaded.\n");
  process.stderr.write(`- Name: ${request.source.chart_name}\n`);
  process.stderr.write(`- Version: ${version}\n\n`);

  // Fetch Chart that has just been uploaded.
  headers = createFetchHeaders(request); // We need new headers. (Content-Length should be "0" again...)
  const chartInfoUrl = `${request.source.server_url}api/chartrepo/${request.source.project}/charts/${request.source.chart_name}/${version}`;
  process.stderr.write(`Fetching chart data from "${chartInfoUrl}"...\n`);
  const chartResp = await fetch(
    `${request.source.server_url}api/chartrepo/${request.source.project}/charts/${request.source.chart_name}/${version}`,
    { headers });
  if (!chartResp.ok) {
    process.stderr.write("Download of chart information failed.\n");
    process.stderr.write((await chartResp.buffer()).toString());
    process.exit(710);
  }
  const chartJson: IHarborChartJSON = await chartResp.json();

  if (version !== chartJson.metadata.version) {
    process.stderr.write(
      `Version mismatch in uploaded Helm Chart. Got: ${chartJson.metadata.version}, expected: ${version}.\n`);
    process.exit(203);
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

  return {
    cleanupCallback,
    data: response,
  };
}

(async () => {
  process.on("unhandledRejection", (err) => {
    process.stderr.write(err != null ? err.toString() : "UNKNOWN ERROR");
    process.exit(-1);
  });
  const result = await out();
  if (typeof result.cleanupCallback === "function") {
    process.stderr.write("Cleaning up...\n");
    // result.cleanupCallback(); // TODO(b.jung) The cleanup callbck causes an error. :-(
  }
  process.stdout.write(JSON.stringify(result.data));
  process.exit(0);
})();
