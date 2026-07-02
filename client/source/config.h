// Build-time config for the 3DS client. With a PSK set, the client finds the
// host by encrypted UDP broadcast (zero-config) and SERVER_HOST is only the
// fallback; without one, SERVER_HOST is used directly (plaintext dev mode).
#ifndef AG3NT_CONFIG_H
#define AG3NT_CONFIG_H

#define SERVER_HOST "192.168.0.229"  // fallback when discovery finds nothing
#define SERVER_PORT 4791
#define DISCOVERY_PORT 41337          // UDP; must match host AG3NT_DISCOVERY_PORT
#define PAIR_TOKEN "ag3nt-3ds"        // must match AG3NT_TOKEN when you run the host
#define PAIR_PSK ""                   // 64 lowercase hex chars enables encrypted
                                      // transport + discovery; must match host
                                      // AG3NT_PSK. Empty = plaintext mode (dev only).

#endif // AG3NT_CONFIG_H
