import XCTest

// Real iOS Simulator screenshots for TfL Delay Repay, driven as a genuine
// XCUITest. On a fresh install the app (a) raises the iOS notification
// permission alert and (b) shows the Welcome onboarding overlay. We dismiss
// the system alert via Springboard, capture Welcome, dismiss it, then walk
// the bottom tab bar. Tabs (Rail flag off): Home | Journeys | Stats | Log |
// Alerts | About. The tab bar is inset by the screen padding, so its centres
// sit ~dy 0.835 and the six x-centres run 0.127 … 0.87 in even 0.149 steps.
final class ScreenshotUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    // Dismiss the system notification-permission alert if it's up.
    @MainActor
    private func dismissSystemAlert() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Allow", "Don’t Allow", "Don't Allow", "OK"] {
            let btn = springboard.buttons[label]
            if btn.waitForExistence(timeout: label == "Allow" ? 6 : 1) {
                btn.tap()
                return
            }
        }
    }

    // Tab the bottom bar. Each tab Pressable now carries an explicit
    // accessibilityLabel/testID of the form "tab-<Label>" (App.tsx), so it is
    // guaranteed to surface as a queryable button. Coordinate fallback remains
    // as a last resort.
    @MainActor
    private func tapTab(_ app: XCUIApplication, _ label: String, fallbackX: CGFloat) {
        let id = "tab-\(label)"
        let b = app.buttons[id]
        if b.waitForExistence(timeout: 3) {
            b.tap()
        } else if app.otherElements[id].waitForExistence(timeout: 1) {
            app.otherElements[id].tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: fallbackX, dy: 0.835)).tap()
        }
        sleep(1)
    }

    @MainActor
    func testScreenshots() throws {
        let app = XCUIApplication()
        setupSnapshot(app)
        app.launch()

        // Clear the notification-permission alert before it eats a tap.
        dismissSystemAlert()
        sleep(2) // let the Welcome overlay settle

        // 1. First-launch onboarding — the value proposition.
        snapshot("01_Welcome")

        // Dismiss the welcome overlay via "Get started".
        let getStarted = app.buttons["Get started"]
        if getStarted.waitForExistence(timeout: 3) {
            getStarted.tap()
        } else if app.staticTexts["Get started"].exists {
            app.staticTexts["Get started"].tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.93)).tap()
        }
        sleep(2)

        // 2. Home dashboard.
        snapshot("02_Home")

        // 3. Alerts tab.
        tapTab(app, "Alerts", fallbackX: 0.72)
        snapshot("03_Alerts")

        // 4. About tab.
        tapTab(app, "About", fallbackX: 0.87)
        snapshot("04_About")
    }
}
