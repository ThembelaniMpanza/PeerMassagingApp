using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Forms = System.Windows.Forms;
namespace IPMessenger.Native;
public partial class MainWindow : Window
{
    private readonly PeerService service = new();
    private readonly Forms.NotifyIcon trayIcon;
    private string? selectedId;
    private bool refreshing, reallyClosing;
    private PairRequest? incoming;
    private int messageCount;
    public MainWindow()
    {
        InitializeComponent();
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Open IP Messenger", null, (_, _) => ShowWindow());
        menu.Items.Add("Exit", null, async (_, _) => await ExitApplication());
        trayIcon = new Forms.NotifyIcon { Text = "IP Messenger", Icon = System.Drawing.SystemIcons.Application, Visible = true, ContextMenuStrip = menu };
        trayIcon.DoubleClick += (_, _) => ShowWindow();
        service.Changed += () => Dispatcher.BeginInvoke(RefreshView);
        service.Error += text => Dispatcher.BeginInvoke(() => ErrorText.Text = text);
        service.PairingCodeChanged += pair => Dispatcher.BeginInvoke(() => { OutgoingPanel.Visibility = pair is null ? Visibility.Collapsed : Visibility.Visible; OutgoingText.Text = pair is null ? "" : $"Enter code {pair.Code} on the other device. Compare this fingerprint before approving:\n{pair.Fingerprint}"; });
        service.PairingRequested += request => Dispatcher.BeginInvoke(() => { selectedId = request.PeerId; PairCodeBox.Clear(); ShowWindow(); RefreshView(); });
        service.MessageReceived += message => Dispatcher.BeginInvoke(() => { if (!IsActive) { trayIcon.BalloonTipTitle = message.Sender; trayIcon.BalloonTipText = message.Text[..Math.Min(message.Text.Length, 200)]; trayIcon.ShowBalloonTip(4000); } });
        Loaded += async (_, _) => await Run(async () => { await service.StartAsync(); LocalText.Text = $"{service.DeviceName}\nListening on TCP {service.Port}"; RefreshView(); });
        Activated += async (_, _) => { if (selectedId is not null) await Run(() => service.MarkReadAsync(selectedId)); };
    }
    private async Task Run(Func<Task> action, bool clearError = true) { try { if (clearError) ErrorText.Text = ""; await action(); } catch (Exception error) { ErrorText.Text = error.Message; } }
    private string Selected => selectedId ?? throw new InvalidOperationException("Select a peer first");
    private void RefreshView()
    {
        refreshing = true;
        var peers = service.Peers; selectedId ??= peers.FirstOrDefault()?.DeviceId;
        DevicesList.ItemsSource = peers; DevicesList.SelectedItem = peers.FirstOrDefault(p => p.DeviceId == selectedId); refreshing = false;
        var peer = peers.FirstOrDefault(p => p.DeviceId == selectedId);
        SelectedPeerText.Text = peer?.Name ?? "Select a peer"; StatusText.Text = peer?.Detail ?? "Waiting for nearby devices"; PairButton.IsEnabled = peer is { Connected: true, Trusted: false };
        var messages = service.Messages.Where(m => m.SenderId == selectedId || m.ReceiverId == selectedId).ToArray(); MessagesList.ItemsSource = messages;
        if (messages.Length != messageCount) { messageCount = messages.Length; MessageScroll.ScrollToEnd(); }
        TransfersList.ItemsSource = service.Transfers.Where(t => t.PeerId == selectedId).ToArray(); incoming = service.PairRequests.FirstOrDefault();
        IncomingPanel.Visibility = incoming is null ? Visibility.Collapsed : Visibility.Visible;
        IncomingText.Text = incoming is null ? "" : $"{incoming.Name} wants to pair. Compare this fingerprint and enter the code shown on that device:\n{incoming.Fingerprint}";
        if (IsActive && selectedId is not null) _ = Run(() => service.MarkReadAsync(selectedId), false);
    }
    private async void Connect_Click(object sender, RoutedEventArgs e) => await Run(async () => { var parts = AddressBox.Text.Trim().Split(':'); if (parts.Length > 2) throw new ArgumentException("Use IPv4:port"); var peer = await service.ConnectAsync(parts[0], parts.Length == 2 ? int.Parse(parts[1]) : 5050); selectedId = peer.DeviceId; RefreshView(); });
    private async void Reconnect_Click(object sender, RoutedEventArgs e) => await Run(async () => { var p = service.Peers.First(p => p.DeviceId == Selected); await service.ConnectAsync(p.Address, p.Port, p.DeviceId); });
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await Run(service.RefreshAsync);
    private async void Pair_Click(object sender, RoutedEventArgs e) => await Run(() => service.RequestPairingAsync(Selected));
    private async void Approve_Click(object sender, RoutedEventArgs e) => await Run(() => service.ApprovePairingAsync(incoming?.PeerId ?? throw new InvalidOperationException("Pairing expired"), PairCodeBox.Text.Trim()));
    private async void Decline_Click(object sender, RoutedEventArgs e) => await Run(() => service.RejectPairingAsync(incoming?.PeerId ?? throw new InvalidOperationException("Pairing expired")));
    private async void Forget_Click(object sender, RoutedEventArgs e) => await Run(() => { service.Forget(Selected); return Task.CompletedTask; });
    private void DevicesList_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (!refreshing && DevicesList.SelectedItem is PeerDevice p) { selectedId = p.DeviceId; messageCount = 0; RefreshView(); } }
    private async Task SendMessage() => await Run(async () => { await service.SendMessageAsync(Selected, MessageBox.Text); MessageBox.Clear(); });
    private async void Send_Click(object sender, RoutedEventArgs e) => await SendMessage();
    private async void MessageBox_KeyDown(object sender, System.Windows.Input.KeyEventArgs e) { if (e.Key == Key.Enter) { e.Handled = true; await SendMessage(); } }
    private void Browse_Click(object sender, RoutedEventArgs e) { var dialog = new Microsoft.Win32.OpenFileDialog(); if (dialog.ShowDialog(this) == true) FilePathBox.Text = dialog.FileName; }
    private async void SendFile_Click(object sender, RoutedEventArgs e) => await Run(() => service.OfferFileAsync(Selected, FilePathBox.Text.Trim()));
    private async void AcceptFile_Click(object sender, RoutedEventArgs e) => await Run(() => service.AcceptFileAsync((string)((System.Windows.Controls.Button)sender).Tag));
    private async void RejectFile_Click(object sender, RoutedEventArgs e) => await Run(() => service.RejectFileAsync((string)((System.Windows.Controls.Button)sender).Tag));
    private async void CancelFile_Click(object sender, RoutedEventArgs e) => await Run(() => service.CancelFileAsync((string)((System.Windows.Controls.Button)sender).Tag));
    private async void ShowFile_Click(object sender, RoutedEventArgs e) => await Run(() => { var path = (string)((System.Windows.Controls.Button)sender).Tag; if (!File.Exists(path)) throw new IOException("No received file saved for this transfer"); Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true }); return Task.CompletedTask; });
    private void Window_Closing(object? sender, System.ComponentModel.CancelEventArgs e) { if (!reallyClosing) { e.Cancel = true; Hide(); } }
    private void ShowWindow() { Show(); WindowState = WindowState.Normal; Activate(); }
    private async Task ExitApplication() { reallyClosing = true; await service.DisposeAsync(); trayIcon.Dispose(); System.Windows.Application.Current.Shutdown(); }
}
