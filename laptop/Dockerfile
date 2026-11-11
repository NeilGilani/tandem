# A Bot's laptop: a small Linux desktop with a browser, terminal, files, office apps and
# Python. One image, one container per Bot. Kept lean so a whole team fits in 5 GB.
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 TZ=America/Los_Angeles
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb openbox tint2 x11-xserver-utils x11-utils x11vnc novnc websockify \
      chromium fonts-liberation fonts-dejavu-core fonts-noto-core \
      lxterminal pcmanfm mousepad libreoffice-calc libreoffice-writer libreoffice-impress libreoffice-gtk3 \
      python3 python3-pandas python3-matplotlib python3-openpyxl python3-docx python3-pip python3-pypdf \
      python3-bs4 python3-lxml python3-requests python3-reportlab python3-pil python3-tabulate python3-xlsxwriter \
      python3-venv python3-opencv ffmpeg \
      xdotool imagemagick socat curl wget git jq unzip zip ca-certificates procps tzdata dbus-x11 \
    && pip3 install --no-cache-dir --break-system-packages python-pptx \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/*

# The laptop's user matches the Mac user's id, so files in shared folders keep the right owner.
RUN useradd -u 501 -g 20 -M -d /home/bot -s /bin/bash bot && mkdir -p /home/bot && chown 501:20 /home/bot

COPY start.sh /usr/local/bin/laptop-start
COPY openbox-rc.xml /etc/xdg/openbox/rc.xml
COPY tint2rc /etc/xdg/tint2/tint2rc
RUN chmod +x /usr/local/bin/laptop-start

# 9223: browser control for the Bot. 6080: the screen, for you to watch or take over.
EXPOSE 9223 6080
CMD ["/usr/local/bin/laptop-start"]
