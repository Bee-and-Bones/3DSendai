// Build-time config for the 3DS client. Set your host's LAN IP and the pairing
// token before building (mirrors rAI3DS's config.h approach). For a remote/VPS
// host, point SERVER_HOST at the tunnel/host address (see M4 in the plan).
#ifndef AG3NT_CONFIG_H
#define AG3NT_CONFIG_H

#define SERVER_HOST "192.168.0.229"  // your Mac's LAN IP (change if it moves)
#define SERVER_PORT 4791
#define PAIR_TOKEN "ag3nt-3ds"        // must match AG3NT_TOKEN when you run the host

#endif // AG3NT_CONFIG_H
