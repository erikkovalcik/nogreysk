#!/bin/bash
# <xbar.title>Kukuk</xbar.title>
# <xbar.version>1.0</xbar.version>
# <xbar.desc>Schvaľovanie Claude Code priamo z lišty Macu.</xbar.desc>
# <xbar.dependencies>node</xbar.dependencies>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
#
# Tento súbor vytvára `node kukuk.js menubar-install`, ktorý doplní cesty nižšie.
exec "__NODE__" "__KUKUK_JS__" menubar
