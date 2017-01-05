# FibaroAPI module for Z-Way

This is a proof of concept. You are free to use it and improve (do pull requests).

So far working only with switches, dimmers, motion, door, temperature and luminance sensors. Z-Way locations are exported to Fibaro App.

Use any user to log in. Not only admin is supported.

NB! This app binds on port 80, hence Z-Way must be executed from root! (which is usually the case)

NB! If you experience authorization problems, you might want to update Z-Way to versions upper to 2.3.0-rc4.

TODO:
- Power consumption updates for switches
- Add support for more devices: blinds, meters, humidity sensors, ....
- Make UI for module configuration (module.json). Currently we autorender all config.* variables. This is enougth for now
- save location icons in config (to show different icons for rooms)
- same (changeable icons) for devices
- fix all TODO in the code
- check for new devices (vDev) added/removed to update Fibaro. Currently Fibaro UI should be fully re-loaded (app on the mobile restarted) to get updated list of devices
- long polling for /api/refreshStates and /api/mobile/refreshStates. Z-Way do not support long polling ;(
- more Fibaro HC API can be implemented in future to allow to add Z-Way as slave to Fibaro HC2. This should be cool!

More API calls can be implemented in future to allow Z-Way as a slave for HC2. Check all you need on https://developer.fibaro.com/ (NB! there are mistakes on that site, a lot of them!) or directly via http://HC_IP/api/interface/data to see the correct response.
Wireshark (tcpdump) can also help to see which requests are sent by the mobile app to HC2 or by HC2 to add another HC2 as a slave.

Project page: https://github.com/kotto83/FibaroAPI

License: GNU GPLv3
