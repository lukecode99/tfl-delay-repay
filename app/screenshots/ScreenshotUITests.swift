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

    @MainActor
    private func tapTab(_ app: XCUIApplication, x: CGFloat) {
        // Tab bar is inset by padding — its row centres sit ~96.5%→83.5% down.
        let pt = app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.835))
        pt.tap()
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

        // 3. Alerts tab (5th of six: x-centre ~0.72).
        tapTab(app, x: 0.72)
        snapshot("03_Alerts")

        // 4. About tab (6th of six: x-centre ~0.87).
        tapTab(app, x: 0.87)
        snapshot("04_About")
    }
}
