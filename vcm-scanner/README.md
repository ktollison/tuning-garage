# VCM Scanner configurations

Put your exported VCM Scanner files here, keeping their original names so the
scanner's load dialogs recognise them:

    channels/   *.Channels.xml        which parameters to log, and how fast
    charts/     *.Charts.xml          line-chart series
    graphs/     *.Graphs.xml          tables/gauges with colour thresholds
    layouts/    *.Layout.xml          a whole scanner window
    math/       *.MathParameter.xml   Math Lab calculated channels

Channel lists contain only numeric ParameterIDs. The app builds a **channel
dictionary** from whatever labels appear in your charts, graphs and layouts and
uses it to name parameters everywhere else, including math expressions. IDs it
has never seen are shown as unknown rather than guessed, so coverage grows as
you chart more.

HP Tuners also uses numeric unit codes; create `unit-codes.json` here to record
what you learn about them.
