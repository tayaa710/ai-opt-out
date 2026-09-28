# NoTrain privacy policy

_Last updated: 28 September 2026_

NoTrain is built so that nothing about you leaves your browser.

## What NoTrain collects

Nothing. NoTrain has no servers, no user accounts, no analytics, no telemetry and no advertising. The
developers never receive any information about you or how you use the extension.

## What is stored on your device

In your browser's local extension storage only:

- your settings (region, notification preferences, reminder interval);
- which services you track and your opt-out progress for each;
- alerts and a history of opt-out actions;
- optionally, the name and email address you type in to fill request letters.

You can export or delete all of it at any time from **Settings**. Uninstalling the extension deletes it.

## Network requests

NoTrain makes one kind of request by itself: about once a week it downloads the public registry file
(`registry/dist/registry.json`) from this project's GitHub repository. The request contains nothing
about you beyond what any web request reveals (such as your IP address to GitHub).

When you choose to opt out of a service, NoTrain opens that service's own settings page in a tab, just
as if you had opened it yourself. When you open the popup, it may check whether the site in the current
tab publishes an `/.well-known/ai-training-opt-out` file.

Request letters are never sent by NoTrain. They open in your own email app or are copied for you to send.

## Permissions and why they're needed

| Permission                                                      | Why                                                                                                                                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                                       | Save your settings and progress on your device.                                                                                                                                     |
| `alarms`                                                        | Schedule the weekly registry update and reminder checks.                                                                                                                            |
| `notifications`                                                 | Tell you when a policy changes or a setting was switched back on.                                                                                                                   |
| `scripting`                                                     | Run the opt-out automation and the on-page guide in a settings tab you opened through NoTrain.                                                                                      |
| `activeTab`                                                     | When you open the popup, recognise the site you're on and check it for a published opt-out file.                                                                                    |
| `cookies` (optional, asked when you click "Detect my accounts") | Check whether you're signed in to supported services. Only the presence of a sign-in cookie is checked; values are never read or stored, and the permission is removed right after. |
| Site access (optional, asked per service)                       | Needed to switch off a setting on that service's page for you. Asked only when you click "Opt out for me", and revocable in Settings.                                               |

## Contact

Questions or concerns: open an issue at https://github.com/tayaa710/ai-opt-out/issues.
