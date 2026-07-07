// U6 (plan-004) — CAMU capture + quirc scan worker for QR pairing.
// COMPILES with devkitPro; runtime UNVERIFIED without hardware.
//
// The outer camera (SELECT_OUT1/PORT_CAM1) streams 400x240 RGB565 into a
// linearAlloc'd buffer on a worker thread (KTD8 — the render loop never blocks
// on svcWaitSynchronization). Each frame after the auto-exposure warmup is
// converted to 8-bit luma (pure helper in cam.h) and fed to the vendored quirc
// decoder. Decoded payloads are handed to the main loop via ab_cam_result();
// the worker keeps scanning until ab_cam_stop(), so rejected payloads retry
// naturally. Every init step is gated: failure tears down and returns <0 (R7).

#include "cam.h"

#include <stdlib.h>
#include <string.h>

#include <3ds.h>

#include "quirc.h"

#define CAM_W 400
#define CAM_H 240
#define WARMUP_FRAMES 5
#define FRAME_TIMEOUT_NS (300 * 1000 * 1000LL)
#define WORKER_STACK (32 * 1024)

static Thread s_thread;
static volatile bool s_running;
static volatile bool s_have;
static LightLock s_lock;
static char s_payload[256];
static u16 *s_frame; // linearAlloc RGB565 capture target
static struct quirc *s_q;
static u32 s_transfer;

static void scan_worker(void *arg) {
  (void)arg;
  int frames = 0;
  while (s_running) {
    Handle ev = 0;
    if (R_FAILED(CAMU_SetReceiving(&ev, s_frame, PORT_CAM1, CAM_W * CAM_H * 2, (s16)s_transfer)))
      break;
    Result rc = svcWaitSynchronization(ev, FRAME_TIMEOUT_NS);
    svcCloseHandle(ev);
    if (R_FAILED(rc)) continue; // timeout: camera stalled; retry
    if (++frames <= WARMUP_FRAMES) continue; // discard auto-exposure warmup

    int qw = 0, qh = 0;
    uint8_t *luma = quirc_begin(s_q, &qw, &qh);
    ab_cam_luma_buf(s_frame, (size_t)qw * (size_t)qh, luma);
    quirc_end(s_q);
    if (quirc_count(s_q) > 0) {
      struct quirc_code code;
      struct quirc_data data;
      quirc_extract(s_q, 0, &code);
      if (quirc_decode(&code, &data) == QUIRC_SUCCESS && data.payload_len > 0) {
        LightLock_Lock(&s_lock);
        size_t n = (size_t)data.payload_len < sizeof(s_payload) - 1 ? (size_t)data.payload_len
                                                                    : sizeof(s_payload) - 1;
        memcpy(s_payload, data.payload, n);
        s_payload[n] = '\0';
        s_have = true;
        LightLock_Unlock(&s_lock);
      }
    }
  }
}

static void teardown(void) {
  if (s_frame) {
    linearFree(s_frame);
    s_frame = NULL;
  }
  if (s_q) {
    quirc_destroy(s_q);
    s_q = NULL;
  }
}

int ab_cam_start(void) {
  if (s_running) return 0;
  s_have = false;
  LightLock_Init(&s_lock);

  if (R_FAILED(camInit())) return -1;

  s_q = quirc_new();
  if (!s_q || quirc_resize(s_q, CAM_W, CAM_H) < 0) {
    teardown();
    camExit();
    return -2;
  }
  s_frame = (u16 *)linearAlloc(CAM_W * CAM_H * 2);
  if (!s_frame) {
    teardown();
    camExit();
    return -3;
  }

  Result rc = 0;
  if (R_SUCCEEDED(rc)) rc = CAMU_SetSize(SELECT_OUT1, SIZE_CTR_TOP_LCD, CONTEXT_A);
  if (R_SUCCEEDED(rc)) rc = CAMU_SetOutputFormat(SELECT_OUT1, OUTPUT_RGB_565, CONTEXT_A);
  if (R_SUCCEEDED(rc)) rc = CAMU_SetFrameRate(SELECT_OUT1, FRAME_RATE_30);
  if (R_SUCCEEDED(rc)) rc = CAMU_SetNoiseFilter(SELECT_OUT1, true);
  if (R_SUCCEEDED(rc)) rc = CAMU_SetAutoExposure(SELECT_OUT1, true);
  if (R_SUCCEEDED(rc)) rc = CAMU_SetAutoWhiteBalance(SELECT_OUT1, true);
  if (R_SUCCEEDED(rc)) rc = CAMU_SetTrimming(PORT_CAM1, false);
  if (R_SUCCEEDED(rc)) rc = CAMU_GetMaxBytes(&s_transfer, CAM_W, CAM_H);
  if (R_SUCCEEDED(rc)) rc = CAMU_SetTransferBytes(PORT_CAM1, s_transfer, CAM_W, CAM_H);
  if (R_SUCCEEDED(rc)) rc = CAMU_Activate(SELECT_OUT1);
  if (R_SUCCEEDED(rc)) rc = CAMU_ClearBuffer(PORT_CAM1);
  if (R_SUCCEEDED(rc)) rc = CAMU_StartCapture(PORT_CAM1);
  if (R_FAILED(rc)) {
    CAMU_Activate(SELECT_NONE);
    teardown();
    camExit();
    return -4;
  }

  s_running = true;
  s32 prio = 0;
  svcGetThreadPriority(&prio, CUR_THREAD_HANDLE);
  s_thread = threadCreate(scan_worker, NULL, WORKER_STACK, prio + 1, -2, false);
  if (!s_thread) {
    s_running = false;
    CAMU_StopCapture(PORT_CAM1);
    CAMU_Activate(SELECT_NONE);
    teardown();
    camExit();
    return -5;
  }
  return 0;
}

void ab_cam_stop(void) {
  if (!s_running && !s_thread) return;
  s_running = false;
  if (s_thread) {
    threadJoin(s_thread, U64_MAX);
    threadFree(s_thread);
    s_thread = NULL;
  }
  CAMU_StopCapture(PORT_CAM1);
  CAMU_Activate(SELECT_NONE);
  teardown();
  camExit();
  s_have = false;
}

bool ab_cam_result(char *out, size_t cap) {
  if (!s_have || cap == 0) return false;
  LightLock_Lock(&s_lock);
  size_t n = strlen(s_payload);
  if (n >= cap) n = cap - 1;
  memcpy(out, s_payload, n);
  out[n] = '\0';
  s_have = false;
  LightLock_Unlock(&s_lock);
  return true;
}
