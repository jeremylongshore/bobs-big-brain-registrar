# Multi Stage Docker Build

A multi stage Docker build separates the build environment from the runtime
environment inside a single Dockerfile. An early stage installs the full
toolchain and compiles the artifact; a later, minimal stage copies only the
finished output and ships that.

The payoff is a much smaller final image with a smaller attack surface: the
compilers, headers, and dev dependencies never reach production. Keeping the
heavy build tools out of the runtime layer is the main reason to reach for this
pattern.
