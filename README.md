# FibaroAPI module for Z-Way

This is a proof of concept. You are free to use it and improve (do pull requests).

So far working only with switches, dimmers, motion sensors and door sensors.

TODO:
- Power updates
- Add support for more devices: blinds, meters, humidity sensors, ....
- Make UI for module configuration (module.json). Currently we autorender all config.* variables. This is enougth for now
- save location icons in config (to show different icons for rooms)
- same (changeable icons) for devices
- fix all TODO in the code
- check for new devices (vDev) added/removed to update Fibaro. Currently Fibaro UI should be fully re-loaded (app on the mobile restarted) to get updated list of devices
- long polling for /api/refreshStates and /api/mobile/refreshStates. Z-Way do not support long polling ;(
- more Fibaro HC API can be implemented in future to allow to add Z-Way as slave to Fibaro HC2. This should be cool!

More API calls to be implemented in future:
/api/refreshStates?last=*&rand=*&lang=en
/api/settings/info
/api/loginStatus
/api/home
/api/settings/location
/api/zwaveSettings
/api/devices/*
/api/weather
/api/users
/api/icons
/api/interface/data
(and many more...)

Check all you need on https://developer.fibaro.com/ (NB! there are mistakes on that site, a lot!) or directly via http://HC_IP/api/interface/data to see the correct response.
Wireshark (tcpdump) can also help.

Project page: https://github.com/kotto83/FibaroAPI

License: GNU GPLv3
