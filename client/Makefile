# Standard devkitPro 3DS homebrew Makefile (citro2d/citro3d).
# Build with the Docker image (see Dockerfile) — devkitPro is not assumed on the host.
#
#   docker run --rm -v "$PWD":/work -w /work devkitpro/devkitarm:latest make
#
# Produces ag3nt.3dsx (run via the Homebrew Launcher).

ifeq ($(strip $(DEVKITARM)),)
$(error "Set up devkitARM: source $$DEVKITPRO/devkitarm or use the Docker image")
endif

TOPDIR ?= $(CURDIR)
include $(DEVKITARM)/3ds_rules

TARGET   := ag3nt
BUILD    := build
SOURCES  := source
INCLUDES := source

ARCH := -march=armv6k -mtune=mpcore -mfloat-abi=hard

CFLAGS  := -g -Wall -O2 -mword-relocations -ffunction-sections $(ARCH) \
           $(INCLUDE) -D__3DS__
CFLAGS  += $(foreach dir,$(INCLUDES),-I$(dir))
LDFLAGS  = -specs=3dsx.specs -g $(ARCH) -Wl,-Map,$(notdir $*.map)

LIBS     := -lcitro2d -lcitro3d -lctru -lm
LIBDIRS  := $(CTRULIB)

# Link with the C compiler driver (C-only project), not the host `ld`.
LD := $(CC)

ifneq ($(BUILD),$(notdir $(CURDIR)))

export OUTPUT := $(CURDIR)/$(TARGET)
export TOPDIR := $(CURDIR)
export VPATH  := $(foreach dir,$(SOURCES),$(CURDIR)/$(dir))
export DEPSDIR := $(CURDIR)/$(BUILD)

CFILES   := $(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.c)))
export OFILES := $(CFILES:.c=.o)
export INCLUDE := $(foreach dir,$(INCLUDES),-I$(CURDIR)/$(dir)) \
                 $(foreach dir,$(LIBDIRS),-I$(dir)/include)
export LIBPATHS := $(foreach dir,$(LIBDIRS),-L$(dir)/lib)

.PHONY: all clean
all:
	@[ -d $(BUILD) ] || mkdir -p $(BUILD)
	@$(MAKE) --no-print-directory -C $(BUILD) -f $(CURDIR)/Makefile

clean:
	@rm -fr $(BUILD) $(TARGET).3dsx $(TARGET).elf $(TARGET).smdh

else

DEPENDS := $(OFILES:.o=.d)

$(OUTPUT).3dsx : $(OUTPUT).elf
$(OUTPUT).elf  : $(OFILES)

-include $(DEPENDS)

endif
