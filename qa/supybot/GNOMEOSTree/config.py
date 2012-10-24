import supybot.conf as conf
import supybot.registry as registry

def configure(advanced):
    conf.registerPlugin('GNOMEOSTree', True)

GNOMEOSTree = conf.registerPlugin('GNOMEOSTree')
