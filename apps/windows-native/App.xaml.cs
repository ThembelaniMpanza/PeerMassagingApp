using System.Windows;

namespace IPMessenger.Native;

public partial class App : System.Windows.Application
{
    private Mutex? instance;
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        instance = new Mutex(true, "Local\\IPMessenger.Native", out var created);
        if (!created)
        {
            System.Windows.MessageBox.Show("IP Messenger is already running. Open it from the system tray.", "IP Messenger");
            instance.Dispose(); instance = null; Shutdown(); return;
        }
        var window = new MainWindow();
        MainWindow = window;
        window.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        instance?.ReleaseMutex(); instance?.Dispose(); base.OnExit(e);
    }
}
