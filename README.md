# FiM AV Assistant

**This README is a work in progress.**

FiM AV Assistant is a tool with the following intentions:

-   Make setting up an event an easy step-by-step process
-   Flag issues early, and provide the volunteer with actionable next steps
-   Ensure consistency across all AV carts
-   Provide information to assist AV staff in troubleshooting issues

These goals are accomplished through an always running Electron app that integrates with live-captions, AutoAV, the FIM AV Backend Service, and FMS.

## Disclaimer

The releases published in this repository are free for anyone to use, but are made specifically for FiM AV carts. Once installed, you might find it very difficult to fully quit
out of. This is intentional. This application may make automatic changes to your computer's networking and audio setup without user confirmation.

## Contribution Notes

As with all FIRSTinMI projects, outside contributions are welcome via pull requests. When making a pull request, please note that the following criteria need to be
met for a PR to be accepted (all of these criteria are enforced through automated testing pipelines):

-   `npm run lint` will need to come back with no errors or warnings
-   The version number in both `package.json` files needs to be bumped, and both need to match
-   The project must successfully build

## Running Locally

```bash
npm start
```

## Production Builds

The builds published on GitHub are signed by the `FIM AV Certificate Authority`, an internal CA which is trusted by official AV hardware.
