# Security Policy

## Supported versions

Liurium is pre-alpha and has no released versions yet, so no version receives security updates. This section will list supported versions once releases exist.

## Reporting a vulnerability

Please do not report security problems in public issues, pull requests, or discussions.

Report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include:

- the affected commit or version,
- steps to reproduce,
- what an attacker could achieve.

Liurium is maintained by one person, so responses are best effort. You will get a reply in the report, and the fix will be credited to you unless you prefer otherwise.

## What counts

Liurium treats notes, file names, imported folders, and project databases as untrusted. Examples of what matters most:

- content shown in the app that runs script or reaches the Tauri API,
- reading, writing, or deleting files outside the opened project,
- bypassing the app's permission model,
- loss or silent overwriting of user data.
